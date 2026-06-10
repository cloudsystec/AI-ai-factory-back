import {
  BRAND_COLORS,
  BRAND_NAME,
  BRAND_TAGLINE,
  PLAN_LABELS,
} from "../brand.js";
import { resolveLoginUrl } from "../email-config.js";
import { escapeHtml } from "../html-utils.js";
import { layoutEmail } from "../layout-email.js";

/**
 * @typedef {Object} WelcomeEmailData
 * @property {string} recipientEmail
 * @property {string} [recipientName]
 * @property {string} [companyName]
 * @property {string} [planId]
 * @property {string} [loginUrl]
 */

/**
 * @param {string} email
 * @returns {string}
 */
export function deriveRecipientName(email) {
  const local = String(email || "").split("@")[0] || "";
  const cleaned = local.replace(/[._+-]+/g, " ").trim();
  if (!cleaned) return "Utilizador";
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

  const subject = `Bem-vindo ao ${BRAND_NAME} ? a sua conta est? pronta`;
  const preheader =
    "A sua conta est? pronta. Entre e crie o primeiro projecto.";

  const badges = [planBadgeHtml(planId), companyBadgeHtml(companyName)]
    .filter(Boolean)
    .join("\n");
  const badgesBlock = badges
    ? `<div style="margin:20px 0 8px 0;">${badges}</div>`
    : "";

  const bodyHtml = `
    <h1 style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND_COLORS.text};">
      Ol?, ${escapeHtml(recipientName)}!
    </h1>
    <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:${BRAND_COLORS.muted};">
      A sua conta no ${escapeHtml(BRAND_NAME)} est? activa. A partir daqui pode criar projectos,
      acompanhar jobs em tempo real e levar o backlog ao deploy com entregas test?veis.
    </p>
    ${badgesBlock}
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
      Ou aceda directamente:
      <a href="${escapeHtml(loginUrl)}" style="color:${BRAND_COLORS.accent};word-break:break-all;">${escapeHtml(loginUrl)}</a>
    </p>
    <p style="margin:24px 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;font-weight:700;color:${BRAND_COLORS.text};">
      Pr?ximos passos
    </p>
    <ol style="margin:0;padding:0 0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:${BRAND_COLORS.muted};">
      <li style="margin-bottom:8px;">Fa?a login com este email (${escapeHtml(recipientEmail)})</li>
      <li style="margin-bottom:8px;">Crie o primeiro projecto</li>
      <li style="margin-bottom:0;">Ligue o GitHub (opcional)</li>
    </ol>
  `.trim();

  const html = layoutEmail({
    preheader,
    bodyHtml,
    footerNote: `Este email foi enviado para ${recipientEmail}`,
  });

  const text = [
    subject,
    "",
    BRAND_TAGLINE,
    "",
    `Ol?, ${recipientName}!`,
    "",
    `A sua conta no ${BRAND_NAME} est? activa. A partir daqui pode criar projectos, acompanhar jobs em tempo real e levar o backlog ao deploy com entregas test?veis.`,
    companyName ? `Empresa: ${companyName}` : "",
    planId && PLAN_LABELS[planId] ? PLAN_LABELS[planId] : "",
    "",
    `Fazer login: ${loginUrl}`,
    "",
    "Pr?ximos passos:",
    `1. Fa?a login com este email (${recipientEmail})`,
    "2. Crie o primeiro projecto",
    "3. Ligue o GitHub (opcional)",
    "",
    `Este email foi enviado para ${recipientEmail}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return { subject, html, text };
}
