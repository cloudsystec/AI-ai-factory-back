import { createLogger } from "../lib/logger.js";
import { createEmailProvider, loadEmailConfig } from "./email-config.js";
import { normalizeRecipients } from "./providers/ses-provider.js";

const log = createLogger("email");

/** @type {import('./types.js').EmailProvider | null} */
let providerPromise = null;

/**
 * @returns {Promise<import('./types.js').EmailProvider>}
 */
function getProvider() {
  if (!providerPromise) {
    providerPromise = createEmailProvider();
  }
  return providerPromise;
}

/**
 * Reseta o provider (útil em testes).
 */
export function resetEmailProviderForTests() {
  providerPromise = null;
}

/**
 * @param {import('./types.js').SendEmailInput} input
 * @returns {Promise<import('./types.js').SendEmailResult>}
 */
export async function sendEmail(input) {
  const to = normalizeRecipients(input.to);
  const subject = String(input.subject || "").trim();
  const text = input.text != null ? String(input.text) : "";
  const html = input.html != null ? String(input.html) : "";

  if (to.length === 0) {
    throw Object.assign(new Error("Destinatário (to) obrigatório"), {
      status: 400,
    });
  }
  if (!subject) {
    throw Object.assign(new Error("Assunto (subject) obrigatório"), {
      status: 400,
    });
  }
  if (!text.trim() && !html.trim()) {
    throw Object.assign(
      new Error("Corpo do e-mail obrigatório (text ou html)"),
      { status: 400 }
    );
  }

  const cfg = loadEmailConfig();
  if ((cfg.provider === "ses" || cfg.provider === "postmark") && !cfg.from) {
    throw Object.assign(new Error("EMAIL_FROM não configurado"), {
      status: 500,
    });
  }

  const provider = await getProvider();
  const result = await provider.send({
    to,
    subject,
    text: text.trim() || undefined,
    html: html.trim() || undefined,
    replyTo: input.replyTo,
    tags: input.tags,
  });

  log.info("E-mail enviado", {
    to,
    subject,
    messageId: result.messageId,
    provider: cfg.provider,
  });

  return result;
}

/**
 * @param {string} templateId
 * @param {string | string[]} to
 * @param {Record<string, unknown>} data
 * @returns {Promise<import('./types.js').SendEmailResult>}
 */
export async function sendTemplatedEmail(templateId, to, data) {
  const { renderTemplate } = await import("./render-template.js");
  const rendered = renderTemplate(templateId, data);
  return sendEmail({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

/**
 * @param {import('./templates/welcome.js').WelcomeEmailData} data
 * @returns {Promise<import('./types.js').SendEmailResult>}
 */
export async function sendWelcomeEmail(data) {
  return sendTemplatedEmail("welcome", data.recipientEmail, data);
}
