import { query } from "../db/pool.js";
import { decrypt } from "../lib/crypto.js";

/**
 * Variáveis de ambiente para o worker CLI (Railway ou ficheiro .env local).
 * @param {string} tenantId
 * @returns {Promise<Record<string, string>>}
 */
export async function buildTenantWorkerEnv(tenantId) {
  const { rows } = await query(
    `SELECT id, cursor_admin_api_key_encrypted
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });
  }

  const env = {
    TENANT_ID: tenantId,
    BACK_URL: String(process.env.PUBLIC_BACK_URL || "").replace(/\/$/, ""),
    WORKER_SECRET: String(process.env.WORKER_SECRET || ""),
    REDIS_URL: String(
      process.env.TENANT_REDIS_URL ||
        process.env.REDIS_URL_DOCKER ||
        process.env.REDIS_URL ||
        ""
    ),
    CURSOR_AGENT_TRUST: String(process.env.CURSOR_AGENT_TRUST ?? "1"),
  };

  if (rows[0].cursor_admin_api_key_encrypted) {
    env.CURSOR_ADMIN_API_KEY = decrypt(rows[0].cursor_admin_api_key_encrypted);
  }

  return env;
}

/**
 * @param {Record<string, string>} env
 * @returns {string[]}
 */
export function formatTenantWorkerEnvLines(env) {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}
