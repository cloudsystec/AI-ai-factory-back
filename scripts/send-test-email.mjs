/**
 * Envia e-mail de teste (SES, Postmark ou provider em EMAIL_PROVIDER).
 *
 * Uso:
 *   npm run email:test -- --to=seu@email.com
 *   npm run email:test -- --to=seu@email.com --template=welcome --name=Daniel --plan=starter
 */
import "dotenv/config";
import { sendEmail, sendWelcomeEmail } from "../src/email/email-service.js";

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) out[body] = "true";
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const to = args.to?.trim();
const template = args.template?.trim().toLowerCase();
const name = args.name?.trim();
const plan = args.plan?.trim();
const company = args.company?.trim();
const subject = args.subject?.trim() || "Teste AI Factory — e-mail";
const text =
  args.text?.trim() ||
  "Este é um e-mail de teste enviado pelo script send-test-email.mjs.";

if (!to) {
  console.error("Uso: npm run email:test -- --to=seu@email.com [--template=welcome] [--name=Nome] [--plan=starter]");
  process.exit(1);
}

try {
  if (template === "welcome") {
    const result = await sendWelcomeEmail({
      recipientEmail: to,
      recipientName: name || undefined,
      planId: plan || undefined,
      companyName: company || undefined,
      loginUrl: args.login?.trim() || undefined,
    });
    console.log("OK — welcome email enviado");
    console.log("messageId:", result.messageId);
    console.log("to:", to);
  } else {
    const result = await sendEmail({
      to,
      subject,
      text,
      html: `<p>${text}</p>`,
    });
    console.log("OK — e-mail enviado");
    console.log("messageId:", result.messageId);
    console.log("to:", to);
    console.log("subject:", subject);
  }
} catch (err) {
  console.error("Falha ao enviar e-mail:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
