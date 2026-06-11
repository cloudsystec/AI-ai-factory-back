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
 * @typedef {Object} UserInvitedEmailData
 * @property {string} recipientEmail
 * @property {string} temporaryPassword
 * @property {string} [recipientName]
 * @property {string} [tenantName]
 * @property {string} [role]
 * @property {string} [loginUrl]
 */

/**
 * @param {UserInvitedEmailData | Record<string, unknown>} raw
 * @returns {import('../types.js').RenderedEmail}
 */
export function renderUserInvitedEmail(raw) {
  const data = /** @type {UserInvitedEmailData} */ (raw);
  const recipientEmail = String(data.recipientEmail || "").trim();
  const temporaryPassword = String(data.temporaryPassword || "");
  const recipientName =
    String(data.recipientName || "").trim() ||
    deriveRecipientName(recipientEmail);
  const loginUrl =
    String(data.loginUrl || "").trim() || resolveLoginUrl(recipientEmail);
  const tenantName = String(data.tenantName || "").trim();

  const subject = dev4lessSubject("Sua conta foi criada");
  const preheader = "Sua conta foi criada. Use a senha temporária para entrar.";

  const bodyHtml = `
    <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND_COLORS.text};">
      Olá, ${escapeHtml(recipientName)}!
    </h1>
    <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${BRAND_COLORS.muted};">
      Foi criada uma conta para você no ${escapeHtml(BRAND_NAME)}${tenantName ? ` (${escapeHtml(tenantName)})` : ""}.
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
      E-mail de acesso: ${escapeHtml(recipientEmail)}
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
    `Olá, ${recipientName}!`,
    "",
    `Foi criada uma conta para você no ${BRAND_NAME}${tenantName ? ` (${tenantName})` : ""}.`,
    "",
    ...temporaryPasswordTextLines(temporaryPassword),
    "",
    `Fazer login: ${loginUrl}`,
    `E-mail de acesso: ${recipientEmail}`,
  ].join("\n");

  return { subject, html, text };
}
