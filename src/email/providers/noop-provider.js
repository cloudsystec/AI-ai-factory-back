/**
 * @returns {import('../types.js').EmailProvider}
 */
export function createNoopEmailProvider() {
  return {
    async send(_input) {
      return { messageId: "noop-message-id" };
    },
  };
}
