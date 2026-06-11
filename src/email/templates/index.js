import { renderWelcomeEmail } from "./welcome.js";
import { renderUserInvitedEmail } from "./user-invited.js";
import { renderPasswordForgotEmail } from "./password-forgot.js";
import { renderPasswordResetTemporaryEmail } from "./password-reset-temporary.js";

/** @typedef {(data: Record<string, unknown>) => import('../types.js').RenderedEmail} TemplateRenderer */

/** @type {Record<string, TemplateRenderer>} */
export const TEMPLATE_REGISTRY = {
  welcome: renderWelcomeEmail,
  "user-invited": renderUserInvitedEmail,
  "password-forgot": renderPasswordForgotEmail,
  "password-reset-temporary": renderPasswordResetTemporaryEmail,
};
