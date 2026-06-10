/**
 * @typedef {Object} SendEmailInput
 * @property {string | string[]} to
 * @property {string} subject
 * @property {string} [text]
 * @property {string} [html]
 * @property {string} [replyTo]
 * @property {Record<string, string>} [tags]
 */

/**
 * @typedef {Object} SendEmailResult
 * @property {string} messageId
 */

/**
 * @typedef {Object} EmailProvider
 * @property {(input: SendEmailInput) => Promise<SendEmailResult>} send
 */

/**
 * @typedef {Object} RenderedEmail
 * @property {string} subject
 * @property {string} html
 * @property {string} text
 */

export {};
