import { renderWelcomeEmail } from "./welcome.js";

/** @typedef {(data: Record<string, unknown>) => import('../types.js').RenderedEmail} TemplateRenderer */

/** @type {Record<string, TemplateRenderer>} */
export const TEMPLATE_REGISTRY = {
  welcome: renderWelcomeEmail,
};
