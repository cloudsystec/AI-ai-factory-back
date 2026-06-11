import { BRAND_COLORS, BRAND_NAME } from "../brand.js";
import { resolveLoginUrl } from "../email-config.js";
import { escapeHtml } from "../html-utils.js";
import { layoutEmail } from "../layout-email.js";
import { dev4lessSubject } from "../subject.js";
import {
  temporaryPasswordHtmlBlock,
  temporaryPasswordTextLines,
} from "./temporary-password-block.js";
import { deriveRecipientName } from "./welcome.js";

/**
 * @param {Record<string, unknown>} raw
 * @returns {import('../types.js').RenderedEmail}
 */
export function renderPasswordForgotEmail(raw) {
  const recipientEmail = String(raw.recipientEmail || "").trim();
  const temporaryPassword = String(raw.temporaryPassword || "");
  const recipientName =
    String(raw.recipientName || "").trim() ||
    deriveRecipientName(recipientEmail);
  const loginUrl =
    String(raw.loginUrl || "").trim() || resolveLoginUrl(recipientEmail);

  const subject = dev4lessSubject("Recuperação de senha");
  const preheader = "Nova senha temporária para acessar sua conta.";

  const bodyHtml = `
    <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND_COLORS.text};">
      Recuperação de senha
    </h1>
    <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${BRAND_COLORS.muted};">
      Olá, ${escapeHtml(recipientName)}. Recebemos um pedido para redefinir o acesso à sua conta no ${escapeHtml(BRAND_NAME)}.
    </p>
    ${temporaryPasswordHtmlBlock(temporaryPassword)}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
      <tr>
        <td align="center" style="border-radius:8px;background-color:${BRAND_COLORS.accent};">
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${BRAND_COLORS.accentFg};text-decoration:none;">
            Fazer login
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:${BRAND_COLORS.muted};">
      Se você não fez este pedido, contate o auditor da sua empresa.
    </p>
  `.trim();

  const html = layoutEmail({
    preheader,
    bodyHtml,
    footerNote: `Este e-mail foi enviado para ${recipientEmail}`,
  });

  const text = [
    subject,
    "",
    `Olá, ${recipientName}.`,
    "",
    "Recebemos um pedido para redefinir o acesso à sua conta.",
    "",
    ...temporaryPasswordTextLines(temporaryPassword),
    "",
    `Fazer login: ${loginUrl}`,
    "",
    "Se você não fez este pedido, contate o auditor da sua empresa.",
  ].join("\n");

  return { subject, html, text };
}
