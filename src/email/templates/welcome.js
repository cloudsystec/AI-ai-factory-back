import {
  BRAND_COLORS,
  BRAND_NAME,
  BRAND_TAGLINE,
  PLAN_LABELS,
} from "../brand.js";
import { resolveLoginUrl } from "../email-config.js";
import { escapeHtml } from "../html-utils.js";
import { layoutEmail } from "../layout-email.js";
import { dev4lessSubject } from "../subject.js";
import {
  temporaryPasswordHtmlBlock,
  temporaryPasswordTextLines,
} from "./temporary-password-block.js";

/**
 * @typedef {Object} WelcomeEmailData
 * @property {string} recipientEmail
 * @property {string} [recipientName]
 * @property {string} [companyName]
 * @property {string} [planId]
 * @property {string} [loginUrl]
 * @property {string} [temporaryPassword]
 */

/**
 * @param {string} email
 * @returns {string}
 */
export function deriveRecipientName(email) {
  const local = String(email || "").split("@")[0] || "";
  const cleaned = local.replace(/[._+-]+/g, " ").trim();
  if (!cleaned) return "Usu\u00e1rio";
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/**
 * @param {string} [planId]
 * @returns {string}
 */
function planBadgeHtml(planId) {
  const key = String(planId || "").trim().toLowerCase();
  const label = PLAN_LABELS[key];
  if (!label) return "";
  return `
    <span style="display:inline-block;margin:0 8px 8px 0;padding:6px 12px;border-radius:999px;background:rgba(0,212,170,0.12);border:1px solid ${BRAND_COLORS.borderGlow};font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;color:${BRAND_COLORS.accent};">
      ${escapeHtml(label)}
    </span>
  `.trim();
}

/**
 * @param {string} [companyName]
 * @returns {string}
 */
function companyBadgeHtml(companyName) {
  const name = String(companyName || "").trim();
  if (!name) return "";
  return `
    <span style="display:inline-block;margin:0 8px 8px 0;padding:6px 12px;border-radius:999px;background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.25);font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:600;color:${BRAND_COLORS.text};">
      ${escapeHtml(name)}
    </span>
  `.trim();
}

/**
 * @param {WelcomeEmailData | Record<string, unknown>} raw
 * @returns {import('../types.js').RenderedEmail}
 */
export function renderWelcomeEmail(raw) {
  /** @type {WelcomeEmailData} */
  const data = /** @type {WelcomeEmailData} */ (raw);
  const recipientEmail = String(data.recipientEmail || "").trim();
  const recipientName =
    String(data.recipientName || "").trim() ||
    deriveRecipientName(recipientEmail);
  const loginUrl =
    String(data.loginUrl || "").trim() ||
    resolveLoginUrl(recipientEmail);
  const companyName = String(data.companyName || "").trim() || undefined;
  const planId = String(data.planId || "").trim() || undefined;
  const temporaryPassword = String(data.temporaryPassword || "").trim();

  const subject = dev4lessSubject("Bem-vindo! Sua conta est\u00e1 pronta");
  const preheader =
    "Sua conta est\u00e1 pronta. Use a senha tempor\u00e1ria para entrar.";

  const badges = [planBadgeHtml(planId), companyBadgeHtml(companyName)]
    .filter(Boolean)
    .join("\n");
  const badgesBlock = badges
    ? `<div style="margin:20px 0 8px 0;">${badges}</div>`
    : "";
  const tempPasswordBlock = temporaryPassword
    ? temporaryPasswordHtmlBlock(temporaryPassword)
    : "";

  const bodyHtml = `
    <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND_COLORS.text};">
      Ol\u00e1, ${escapeHtml(recipientName)}!
    </h1>
    <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${BRAND_COLORS.muted};">
      Sua conta no ${escapeHtml(BRAND_NAME)} est\u00e1 ativa. A partir daqui voc\u00ea pode criar projetos,
      acompanhar jobs em tempo real e levar o backlog ao deploy com entregas test\u00e1veis.
    </p>
    ${badgesBlock}
    ${tempPasswordBlock}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
      <tr>
        <td align="center" style="border-radius:8px;background-color:${BRAND_COLORS.accent};">
          <a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${BRAND_COLORS.accentFg};text-decoration:none;">
            Fazer login
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:${BRAND_COLORS.muted};">
      Ou acesse diretamente:
      <a href="${escapeHtml(loginUrl)}" style="color:${BRAND_COLORS.accent};word-break:break-all;">${escapeHtml(loginUrl)}</a>
    </p>
    <p style="margin:24px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;font-weight:700;color:${BRAND_COLORS.text};">
      Pr\u00f3ximos passos
    </p>
    <ol style="margin:0;padding:0 0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:${BRAND_COLORS.muted};">
      <li style="margin-bottom:8px;">Fa\u00e7a login com este e-mail (${escapeHtml(recipientEmail)})</li>
      <li style="margin-bottom:8px;">Defina uma nova senha quando solicitado</li>
      <li style="margin-bottom:8px;">Crie o primeiro projeto</li>
      <li style="margin-bottom:0;">Conecte o GitHub (opcional)</li>
    </ol>
  `.trim();

  const html = layoutEmail({
    preheader,
    bodyHtml,
    footerNote: `Este e-mail foi enviado para ${recipientEmail}`,
  });

  const text = [
    subject,
    "",
    BRAND_TAGLINE,
    "",
    `Ol\u00e1, ${recipientName}!`,
    "",
    `Sua conta no ${BRAND_NAME} est\u00e1 ativa.`,
    companyName ? `Empresa: ${companyName}` : "",
    planId && PLAN_LABELS[planId] ? PLAN_LABELS[planId] : "",
    "",
    ...(temporaryPassword ? temporaryPasswordTextLines(temporaryPassword) : []),
    ...(temporaryPassword ? [""] : []),
    `Fazer login: ${loginUrl}`,
    "",
    "Pr\u00f3ximos passos:",
    `1. Fa\u00e7a login com este e-mail (${recipientEmail})`,
    "2. Defina uma nova senha quando solicitado",
    "3. Crie o primeiro projeto",
    "4. Conecte o GitHub (opcional)",
    "",
    `Este e-mail foi enviado para ${recipientEmail}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { subject, html, text };
}
