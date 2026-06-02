/**
 * Emails com acesso admin de plataforma (PLATFORM_ADMIN_EMAILS).
 */

/**
 * @returns {string[]}
 */
export function getPlatformAdminEmails() {
  return (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string|null|undefined} email
 * @returns {boolean}
 */
export function isPlatformAdminEmail(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  return getPlatformAdminEmails().includes(normalized);
}

/**
 * SQL fragment: exclude platform admin emails from a user row alias.
 * @param {string} emailColumn e.g. "u.email"
 * @param {number} [startParamIndex=1] índice do 1.º placeholder ($N) para os emails
 * @returns {{ sql: string, params: string[] }}
 */
export function sqlExcludePlatformAdminEmails(emailColumn, startParamIndex = 1) {
  const emails = getPlatformAdminEmails();
  if (emails.length === 0) {
    return { sql: "TRUE", params: [] };
  }
  const start = Number(startParamIndex) || 1;
  const placeholders = emails
    .map((_, i) => `$${start + i}`)
    .join(", ");
  return {
    sql: `LOWER(${emailColumn}) NOT IN (${placeholders})`,
    params: emails,
  };
}
