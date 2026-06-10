import { createLogger } from "../../lib/logger.js";

const log = createLogger("email");

/**
 * @returns {import('../types.js').EmailProvider}
 */
export function createConsoleEmailProvider() {
  return {
    async send(input) {
      const to = Array.isArray(input.to) ? input.to : [input.to];
      log.info("Console email (não enviado)", {
        to,
        subject: input.subject,
        hasHtml: Boolean(input.html),
        hasText: Boolean(input.text),
      });
      return { messageId: `console-${Date.now()}` };
    },
  };
}
