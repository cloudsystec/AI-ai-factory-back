import { query } from "../db/pool.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { hashPassword } from "../lib/password.js";
import { buildCapabilities } from "../lib/capabilities.js";
import {
  isPlatformAdminEmail,
  sqlExcludePlatformAdminEmails,
} from "../lib/platform-admin-emails.js";
import { limitsForPlan } from "./tenant-service.js";

const ROLES = new Set(["executor", "auditor", "viewer"]);

/**
 * @param {string} tenantId
 */
export async function getTenantUserQuota(tenantId) {
  const exclude = sqlExcludePlatformAdminEmails("u.email", 2);
  const { rows } = await query(
    `SELECT t.users_max, t.plan_id,
            (SELECT COUNT(*)::int FROM users u
             WHERE u.tenant_id = t.id AND ${exclude.sql}) AS users_used
     FROM tenants t WHERE t.id = $1`,
    [tenantId, ...exclude.params]
  );
  if (!rows[0]) return null;
  return {
    usersMax: rows[0].users_max,
    usersUsed: rows[0].users_used,
    planId: rows[0].plan_id,
  };
}

/**
 * @param {string} tenantId
 */
export async function assertCanAddUser(tenantId) {
  const quota = await getTenantUserQuota(tenantId);
  if (!quota) {
    throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });
  }
  if (quota.usersUsed >= quota.usersMax) {
    throw Object.assign(new Error("Limite de utilizadores do plano atingido"), {
      status: 403,
      code: "plan_user_limit_reached",
      usersUsed: quota.usersUsed,
      usersMax: quota.usersMax,
      planId: quota.planId,
    });
  }
  return quota;
}

/**
 * @param {string} userId
 * @param {string} tenantId
 */
export async function getUserInTenant(userId, tenantId) {
  const { rows } = await query(
    `SELECT id, tenant_id, email, role, password_hash, cursor_api_key_encrypted, created_at
     FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
  return rows[0] || null;
}

/**
 * @param {object} row
 */
export function userToPublic(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    hasPassword: Boolean(row.password_hash),
    hasCursorKey:
      row.role === "executor" && Boolean(row.cursor_api_key_encrypted),
    createdAt: row.created_at,
  };
}

/**
 * @param {string} tenantId
 */
export async function listTenantUsers(tenantId) {
  const quota = await getTenantUserQuota(tenantId);
  const { rows } = await query(
    `SELECT id, email, role, password_hash, cursor_api_key_encrypted, created_at
     FROM users WHERE tenant_id = $1 ORDER BY email`,
    [tenantId]
  );
  const visible = rows.filter((row) => !isPlatformAdminEmail(row.email));
  return {
    users: visible.map(userToPublic),
    usersUsed: quota?.usersUsed ?? visible.length,
    usersMax: quota?.usersMax ?? 5,
    planId: quota?.planId,
  };
}

/**
 * @param {string} tenantId
 * @param {{ email: string, role: string, password: string }} input
 * @param {{ allowedRoles?: Set<string> }} [opts]
 */
export async function createTenantUser(tenantId, input, opts = {}) {
  await assertCanAddUser(tenantId);
  const email = String(input.email).trim().toLowerCase();
  const role = String(input.role || "").trim();
  const password = input.password;

  if (!email || !ROLES.has(role)) {
    throw Object.assign(new Error("email e role inválidos"), { status: 400 });
  }
  if (opts.allowedRoles && !opts.allowedRoles.has(role)) {
    throw Object.assign(new Error("role não permitido"), { status: 403 });
  }
  if (typeof password !== "string" || password.length < 6) {
    throw Object.assign(new Error("password obrigatória (mín. 6 caracteres)"), {
      status: 400,
    });
  }

  const passwordHash = hashPassword(password);
  try {
    const { rows } = await query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, password_hash, cursor_api_key_encrypted, created_at`,
      [tenantId, email, role, passwordHash]
    );
    return userToPublic(rows[0]);
  } catch (e) {
    if (e.code === "23505") {
      throw Object.assign(new Error("Email já registado neste tenant"), {
        status: 409,
      });
    }
    throw e;
  }
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {{ role?: string }} patch
 * @param {{ allowedRoles?: Set<string> }} [opts]
 */
export async function updateTenantUserRole(tenantId, userId, patch, opts = {}) {
  const user = await getUserInTenant(userId, tenantId);
  if (!user) {
    throw Object.assign(new Error("Utilizador não encontrado"), { status: 404 });
  }
  const role = String(patch.role || "").trim();
  if (!ROLES.has(role)) {
    throw Object.assign(new Error("role inválido"), { status: 400 });
  }
  if (opts.allowedRoles && !opts.allowedRoles.has(role)) {
    throw Object.assign(new Error("role não permitido"), { status: 403 });
  }
  if (user.role === "auditor" && role !== "auditor") {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'auditor'`,
      [tenantId]
    );
    if (rows[0].n <= 1) {
      throw Object.assign(
        new Error("O tenant deve manter pelo menos um auditor"),
        { status: 409 }
      );
    }
  }

  const { rows } = await query(
    `UPDATE users SET role = $3 WHERE id = $1 AND tenant_id = $2
     RETURNING id, email, role, password_hash, cursor_api_key_encrypted, created_at`,
    [userId, tenantId, role]
  );
  return userToPublic(rows[0]);
}

/**
 * @param {string} tenantId
 * @param {string} userId
 */
export async function deleteTenantUser(tenantId, userId) {
  const user = await getUserInTenant(userId, tenantId);
  if (!user) {
    throw Object.assign(new Error("Utilizador não encontrado"), { status: 404 });
  }
  if (user.role === "auditor") {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM users WHERE tenant_id = $1 AND role = 'auditor'`,
      [tenantId]
    );
    if (rows[0].n <= 1) {
      throw Object.assign(
        new Error("Não é possível remover o último auditor do tenant"),
        { status: 409 }
      );
    }
  }
  await query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [
    userId,
    tenantId,
  ]);
  return { ok: true };
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} password
 */
export async function setUserPassword(tenantId, userId, password) {
  const user = await getUserInTenant(userId, tenantId);
  if (!user) {
    throw Object.assign(new Error("Utilizador não encontrado"), { status: 404 });
  }
  if (typeof password !== "string" || password.length < 6) {
    throw Object.assign(new Error("password inválida (mín. 6 caracteres)"), {
      status: 400,
    });
  }
  const passwordHash = hashPassword(password);
  await query(
    "UPDATE users SET password_hash = $3 WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId, passwordHash]
  );
  return { ok: true };
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} cursorApiKey
 */
export async function setExecutorCursorApiKey(tenantId, userId, cursorApiKey) {
  const user = await getUserInTenant(userId, tenantId);
  if (!user) {
    throw Object.assign(new Error("Utilizador não encontrado"), { status: 404 });
  }
  if (user.role !== "executor") {
    throw Object.assign(new Error("API key só para utilizadores executor"), {
      status: 400,
    });
  }
  const key = String(cursorApiKey || "").trim();
  if (!key) {
    throw Object.assign(new Error("cursorApiKey obrigatória"), { status: 400 });
  }
  const enc = encrypt(key);
  await query(
    "UPDATE users SET cursor_api_key_encrypted = $3 WHERE id = $1 AND tenant_id = $2",
    [userId, tenantId, enc]
  );
  return { ok: true, hasCursorKey: true };
}

/**
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function getExecutorCursorApiKeyDecrypted(userId) {
  const { rows } = await query(
    `SELECT cursor_api_key_encrypted, role FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]?.cursor_api_key_encrypted) return null;
  return decrypt(rows[0].cursor_api_key_encrypted);
}

/**
 * @param {string} userId
 */
export async function loadSessionUser(userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.tenant_id,
            t.plan_active_until, t.name AS tenant_name
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * @param {string} email
 */
export async function loadUserByEmail(email) {
  const { rows } = await query(
    `SELECT u.id, u.email, u.role, u.tenant_id, u.password_hash,
            t.plan_active_until, t.name AS tenant_name
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [email.trim().toLowerCase()]
  );
  return rows[0] || null;
}

/**
 * @param {string} userId
 */
export async function getCapabilitiesForUser(userId) {
  const user = await loadSessionUser(userId);
  if (!user) return null;
  const quota = await getTenantUserQuota(user.tenant_id);
  return buildCapabilities(user.role, {
    usersUsed: quota?.usersUsed ?? 0,
    usersMax: quota?.usersMax ?? 5,
  });
}

/**
 * @param {string} tenantId
 * @param {number} usersMax
 */
export async function setTenantUsersMax(tenantId, usersMax) {
  const n = Number(usersMax);
  if (!Number.isInteger(n) || n < 1) {
    throw Object.assign(new Error("usersMax inválido"), { status: 400 });
  }
  await query(
    "UPDATE tenants SET users_max = $2, updated_at = now() WHERE id = $1",
    [tenantId, n]
  );
  return { usersMax: n };
}

/**
 * @param {string} executorUserId
 */
export async function assertExecutorCanRunJobs(executorUserId) {
  const { rows } = await query(
    `SELECT id, role, email FROM users WHERE id = $1`,
    [executorUserId]
  );
  const u = rows[0];
  if (!u || u.role !== "executor") {
    throw Object.assign(new Error("Apenas executores podem iniciar jobs"), {
      status: 403,
    });
  }
  return u;
}

export { ROLES };
