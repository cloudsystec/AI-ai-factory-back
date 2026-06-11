import { BRAND_COLORS, BRAND_NAME, BRAND_TAGLINE } from "./brand.js";
import { resolveEmailLogoUrl } from "./email-config.js";
import { escapeHtml } from "./html-utils.js";

/**
 * @returns {string}
 */
function renderHtmlBrandHeader() {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="padding:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:36px;line-height:1.1;letter-spacing:-1px;">
          <span style="color:#ffffff;font-weight:600;">dev</span><span style="color:${BRAND_COLORS.muted};font-weight:400;">for</span><span style="color:${BRAND_COLORS.accent};font-weight:600;">less</span>
        </td>
      </tr>
    </table>
  `.trim();
}

/**
 * @param {string | null} logoUrl
 * @returns {string}
 */
function renderEmailHeader(logoUrl) {
  const tagline = `
    <p style="margin:12px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;color:${BRAND_COLORS.muted};letter-spacing:0.08em;text-transform:uppercase;">
      ${escapeHtml(BRAND_TAGLINE)}
    </p>
    <div style="margin:16px 0 0 0;height:1px;background:${BRAND_COLORS.divider};line-height:1px;font-size:1px;">&nbsp;</div>
  `;

  if (logoUrl) {
    return `
      <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(BRAND_NAME)}" width="240" style="display:block;border:0;max-width:240px;height:auto;" />
      ${tagline}
    `.trim();
  }

  return `${renderHtmlBrandHeader()}${tagline}`;
}

/**
 * @param {{ preheader?: string, bodyHtml: string, logoUrl?: string | null, footerNote?: string }} opts
 * @returns {string}
 */
export function layoutEmail({
  preheader = "",
  bodyHtml,
  logoUrl = undefined,
  footerNote = "",
}) {
  const resolvedLogo =
    logoUrl !== undefined ? logoUrl : resolveEmailLogoUrl();
  const header = renderEmailHeader(resolvedLogo);
  const year = new Date().getFullYear();
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : "";
  const footerExtra = footerNote
    ? `<br /><span style="color:${BRAND_COLORS.muted};">${escapeHtml(footerNote)}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${escapeHtml(BRAND_NAME)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_COLORS.bg};">
  ${hiddenPreheader}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BRAND_COLORS.bg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">
          <tr>
            <td style="padding:0 0 24px 0;">
              ${header}
            </td>
          </tr>
          <tr>
            <td style="background-color:${BRAND_COLORS.card};border:1px solid ${BRAND_COLORS.borderGlow};border-radius:12px;padding:32px 28px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 8px 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:${BRAND_COLORS.muted};">
              ${escapeHtml(BRAND_NAME)} · ${year}${footerExtra}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
