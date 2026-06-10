import { TEMPLATE_REGISTRY } from "./templates/index.js";

export { escapeHtml } from "./html-utils.js";
export { layoutEmail } from "./layout-email.js";

/**
 * @param {string} templateId
 * @param {Record<string, unknown>} data
 * @returns {import('./types.js').RenderedEmail}
 */
export function renderTemplate(templateId, data) {
  const renderer = TEMPLATE_REGISTRY[templateId];
  if (!renderer) {
    throw Object.assign(new Error(`Template de e-mail desconhecido: ${templateId}`), {
      status: 400,
    });
  }
  return renderer(data);
}
