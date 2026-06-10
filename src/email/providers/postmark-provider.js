import { normalizeRecipients } from "./ses-provider.js";

const POSTMARK_API_URL =
  process.env.POSTMARK_API_URL || "https://api.postmarkapp.com/email";

/**
 * @returns {string | null}
 */
export function getPostmarkServerToken() {
  return (
    String(process.env.POSTMARK_SERVER_TOKEN || "").trim() ||
    String(process.env.POSTMARK_API_TOKEN || "").trim() ||
    null
  );
}

/**
 * @param {ReturnType<import('../email-config.js').loadEmailConfig>} cfg
 * @returns {import('../types.js').EmailProvider}
 */
export function createPostmarkEmailProvider(cfg) {
  const token = getPostmarkServerToken();
  if (!token) {
    throw new Error(
      "Postmark não configurado: defina POSTMARK_SERVER_TOKEN (Server API token)"
    );
  }

  const fromAddress = cfg.fromName
    ? `${cfg.fromName} <${cfg.from}>`
    : cfg.from;

  const messageStream =
    String(process.env.POSTMARK_MESSAGE_STREAM || "").trim() || "outbound";

  return {
    async send(input) {
      const to = normalizeRecipients(input.to);
      if (to.length === 0) {
        throw Object.assign(new Error("Destinatário obrigatório"), {
          status: 400,
        });
      }

      const hasText = Boolean(input.text?.trim());
      const hasHtml = Boolean(input.html?.trim());
      if (!hasText && !hasHtml) {
        throw Object.assign(
          new Error("text ou html obrigatório para envio de e-mail"),
          { status: 400 }
        );
      }

      /** @type {Record<string, string>} */
      const body = {
        From: fromAddress,
        To: to.join(", "),
        Subject: input.subject,
        MessageStream: messageStream,
      };

      if (hasText) body.TextBody = input.text;
      if (hasHtml) body.HtmlBody = input.html;

      const replyTo = input.replyTo || cfg.replyTo;
      if (replyTo) body.ReplyTo = replyTo;

      const res = await fetch(POSTMARK_API_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": token,
        },
        body: JSON.stringify(body),
      });

      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        const detail =
          payload?.Message ||
          payload?.message ||
          JSON.stringify(payload).slice(0, 500);
        throw new Error(`Falha ao enviar e-mail via Postmark: ${detail}`);
      }

      return {
        messageId: payload.MessageID || payload.MessageId || "postmark-unknown",
      };
    },
  };
}
