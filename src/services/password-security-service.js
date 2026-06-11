import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createLogger } from "../lib/logger.js";
import { sendForgotPasswordEmail, sendPasswordResetTemporaryEmail } from "../email/email-service.js";

const log = createLogger("password-security");

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const PASSWORD_RECOVERY_COOLDOWN_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

/**
 * @returns {string}
 */
export function generateTemporaryPassword() {
  const fromEnv = process.env.STRIPE_DEFAULT_USER_PASSWORD;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const generated = crypto.randomBytes(12).toString("base64url");
  if (process.env.NODE_ENV !== "production") {
    log.info("Senha temporária gerada", { password: generated });
  }
  return generated;
}

/**
 * @param {string} password
 */
export function assertPasswordStrength(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(
      new Error(`Senha inválida (mín. ${MIN_PASSWORD_LENGTH} caracteres)`),
      { status: 400, code: "weak_password" }
    );
  }
}

/**
 * @param {{ locked_at?: Date | string | null }} user
 */
export function isUserLocked(user) {
  return Boolean(user?.locked_at);
}

/**
 * @param {{ locked_at?: Date | string | null }} user
 */
export function assertUserCanAuthenticate(user) {
  if (isUserLocked(user)) {
    throw Object.assign(new Error("Conta bloqueada"), {
      status: 403,
      code: "account_locked",
    });
  }
}

/**
 * @param {string} userId
 * @param {{ mustChange?: boolean, clearFailedAttempts?: boolean }} [opts]
 * @returns {Promise<string>} plaintext password (once)
 */
export async function applyTemporaryPassword(userId, opts = {}) {
  const { mustChange = true, clearFailedAttempts = true } = opts;
  const plaintext = generateTemporaryPassword();
  const passwordHash = hashPassword(plaintext);

  await query(
    `UPDATE users SET
       password_hash = $2,
       password_must_change = $3,
       failed_login_attempts = CASE WHEN $4 THEN 0 ELSE failed_login_attempts END
     WHERE id = $1`,
    [userId, passwordHash, mustChange, clearFailedAttempts]
  );

  return plaintext;
}

/**
 * @param {string} userId
 * @returns {Promise<{ locked: boolean, attempts: number }>}
 */
export async function recordFailedLogin(userId) {
  const { rows } = await query(
    `UPDATE users SET
       failed_login_attempts = failed_login_attempts + 1,
       locked_at = CASE
         WHEN failed_login_attempts + 1 >= $2 THEN now()
         ELSE locked_at
       END
     WHERE id = $1
     RETURNING failed_login_attempts, locked_at`,
    [userId, MAX_FAILED_LOGIN_ATTEMPTS]
  );
  const row = rows[0];
  return {
    locked: Boolean(row?.locked_at),
    attempts: row?.failed_login_attempts ?? 0,
  };
}

/**
 * @param {string} userId
 */
export async function recordSuccessfulLogin(userId) {
  await query(
    `UPDATE users SET failed_login_attempts = 0 WHERE id = $1`,
    [userId]
  );
}

/**
 * @param {string} tenantId
 * @param {string} userId
 */
export async function unlockUser(tenantId, userId) {
  const { rows } = await query(
    `UPDATE users SET locked_at = NULL, failed_login_attempts = 0
     WHERE id = $1 AND tenant_id = $2
     RETURNING id`,
    [userId, tenantId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Usuário não encontrado"), { status: 404 });
  }
  return { ok: true };
}

/**
 * @param {string} userId
 * @param {{ currentPassword: string, newPassword: string, confirmNewPassword?: string }} input
 * @param {{ password_hash?: string | null, password_must_change?: boolean }} user
 */
export async function changeOwnPassword(userId, input, user) {
  const currentPassword = input.currentPassword;
  const newPassword = input.newPassword;
  const confirmNewPassword = input.confirmNewPassword ?? newPassword;

  if (typeof currentPassword !== "string" || !currentPassword) {
    throw Object.assign(new Error("Senha atual obrigatória"), { status: 400 });
  }
  if (newPassword !== confirmNewPassword) {
    throw Object.assign(new Error("Confirmação de senha não coincide"), {
      status: 400,
      code: "password_mismatch",
    });
  }
  assertPasswordStrength(newPassword);

  if (!user.password_hash || !verifyPassword(currentPassword, user.password_hash)) {
    throw Object.assign(new Error("Senha atual incorreta"), {
      status: 401,
      code: "invalid_current_password",
    });
  }
  if (verifyPassword(newPassword, user.password_hash)) {
    throw Object.assign(new Error("A nova senha deve ser diferente da atual"), {
      status: 400,
      code: "same_password",
    });
  }

  const passwordHash = hashPassword(newPassword);
  await query(
    `UPDATE users SET
       password_hash = $2,
       password_must_change = false,
       failed_login_attempts = 0
     WHERE id = $1`,
    [userId, passwordHash]
  );
  return { ok: true, mustChangePassword: false };
}

const FORGOT_PASSWORD_MESSAGE =
  "Se o email existir na nossa base, receberá instruções em breve.";

/**
 * @param {string} email
 * @returns {Promise<{ ok: true, message: string, sent?: boolean }>}
 */
export async function requestPasswordRecovery(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) {
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
  }

  const { rows } = await query(
    `SELECT u.id, u.email, u.locked_at, u.last_password_recovery_sent_at,
            t.plan_active_until
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [normalized]
  );
  const user = rows[0];
  if (!user) {
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
  }
  if (new Date(user.plan_active_until) < new Date()) {
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
  }
  if (user.locked_at) {
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
  }
  if (user.last_password_recovery_sent_at) {
    const elapsed =
      Date.now() - new Date(user.last_password_recovery_sent_at).getTime();
    if (elapsed < PASSWORD_RECOVERY_COOLDOWN_MS) {
      return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
    }
  }

  const temporaryPassword = await applyTemporaryPassword(user.id, {
    mustChange: true,
    clearFailedAttempts: true,
  });

  await query(
    `UPDATE users SET last_password_recovery_sent_at = now() WHERE id = $1`,
    [user.id]
  );

  try {
    await sendForgotPasswordEmail({
      recipientEmail: user.email,
      temporaryPassword,
    });
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE, sent: true };
  } catch (e) {
    log.error("Falha ao enviar email de recuperação", {
      userId: user.id,
      error: e.message,
    });
    return { ok: true, message: FORGOT_PASSWORD_MESSAGE };
  }
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} recipientEmail
 */
export async function resetTemporaryPasswordForUser(tenantId, userId, recipientEmail) {
  const temporaryPassword = await applyTemporaryPassword(userId, {
    mustChange: true,
    clearFailedAttempts: true,
  });
  await sendPasswordResetTemporaryEmail({
    recipientEmail,
    temporaryPassword,
  });
  return { ok: true, emailSent: true };
}
