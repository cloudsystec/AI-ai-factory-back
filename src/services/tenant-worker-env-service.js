import { query } from "../db/pool.js";
import { decrypt } from "../lib/crypto.js";

/** URL da API para workers (rede privada Railway ou pública). */
export function resolveWorkerBackUrl() {
  return String(
    process.env.WORKER_BACK_URL || process.env.PUBLIC_BACK_URL || ""
  ).replace(/\/$/, "");
}

/** Redis para workers (preferir URL privada em produção). */
export function resolveWorkerRedisUrl() {
  return String(
    process.env.WORKER_REDIS_URL ||
      process.env.TENANT_REDIS_URL ||
      process.env.REDIS_URL_DOCKER ||
      process.env.REDIS_URL ||
      ""
  );
}

const DEFAULT_LOCAL_WORKER_BACK_URL = "http://host.docker.internal:4000";
const DEFAULT_LOCAL_WORKER_REDIS_URL = "redis://host.docker.internal:6379";

function isLocalhostUrl(value) {
  const url = String(value || "").trim();
  return !url || url.includes("127.0.0.1") || url.includes("localhost");
}

function pickLocalWorkerRedisUrl(current) {
  const candidates = [
    current,
    process.env.TENANT_REDIS_URL,
    process.env.REDIS_URL_DOCKER,
  ];
  for (const candidate of candidates) {
    const url = String(candidate || "").trim();
    if (url && !isLocalhostUrl(url)) return url;
  }
  return DEFAULT_LOCAL_WORKER_REDIS_URL;
}

/**
 * Defaults para worker Docker local (container não alcança 127.0.0.1 do host).
 * @param {Record<string, string>} env
 */
export function applyLocalDockerWorkerEnvDefaults(env) {
  const next = { ...env };
  if (isLocalhostUrl(next.BACK_URL)) {
    const back =
      process.env.LOCAL_WORKER_BACK_URL?.replace(/\/$/, "") ||
      process.env.WORKER_BACK_URL?.replace(/\/$/, "") ||
      process.env.PUBLIC_BACK_URL?.replace(/\/$/, "") ||
      "";
    next.BACK_URL = isLocalhostUrl(back) ? DEFAULT_LOCAL_WORKER_BACK_URL : back;
  }
  next.REDIS_URL = pickLocalWorkerRedisUrl(next.REDIS_URL);
  return next;
}

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
    BACK_URL: resolveWorkerBackUrl(),
    WORKER_SECRET: String(process.env.WORKER_SECRET || ""),
    REDIS_URL: resolveWorkerRedisUrl(),
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
