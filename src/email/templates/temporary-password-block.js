import { BRAND_COLORS } from "../brand.js";
import { escapeHtml } from "../html-utils.js";

/**
 * @param {string} temporaryPassword
 * @returns {string}
 */
export function temporaryPasswordHtmlBlock(temporaryPassword) {
  const pwd = escapeHtml(String(temporaryPassword || ""));
  return `
    <div style="margin:24px 0;padding:16px 20px;border-radius:8px;background:rgba(0,212,170,0.08);border:1px solid ${BRAND_COLORS.borderGlow};">
      <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;color:${BRAND_COLORS.text};">
        Senha temporária
      </p>
      <p style="margin:0 0 12px 0;font-family:Consolas,Monaco,monospace;font-size:18px;font-weight:700;letter-spacing:0.05em;color:${BRAND_COLORS.accent};">
        ${pwd}
      </p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:${BRAND_COLORS.muted};">
        No primeiro acesso, será obrigatório definir uma nova senha. Use esta senha temporária como &quot;senha atual&quot; na tela de alteração de senha.
      </p>
    </div>
  `.trim();
}

/**
 * @param {string} temporaryPassword
 * @returns {string[]}
 */
export function temporaryPasswordTextLines(temporaryPassword) {
  return [
    "Senha temporária:",
    String(temporaryPassword || ""),
    "",
    "No primeiro acesso, será obrigatório definir uma nova senha.",
    "Use esta senha temporária como senha atual na tela de alteração de senha.",
  ];
}
