import { query } from "../db/pool.js";
import {
  getBotWorkerApiKeyDecrypted,
  isBotReady,
} from "./worker-bot-service.js";

/** Jobs que invocam o Cursor CLI (`agent`) — exigem chave do bot (worker slot). */
export const CURSOR_AGENT_JOB_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
  "railway-publish",
]);

/**
 * Utilizador executor associado ao job (fila manual ou Play contínuo).
 * @param {string} tenantId
 * @param {{ requested_by_user_id?: string|null, project_slug?: string }} job
 */
export async function resolveJobExecutorUserId(tenantId, job) {
  if (job.requested_by_user_id) return job.requested_by_user_id;
  if (!job.project_slug) return null;
  const { rows } = await query(
    `SELECT executor_user_id FROM tenant_execution
     WHERE tenant_id = $1 AND project_slug = $2 AND executor_user_id IS NOT NULL`,
    [tenantId, job.project_slug]
  );
  return rows[0]?.executor_user_id || null;
}

/**
 * Chave Cursor de execução do bot (por slot). Admin API key é separada (tenant).
 * @param {string} tenantId
 * @param {{ kind: string }} job
 * @param {number} workerSlot
 */
export async function resolveCursorApiKeyForJob(tenantId, job, workerSlot) {
  if (job.kind === "provision" || job.kind === "git-migrate") {
    return null;
  }
  if (!CURSOR_AGENT_JOB_KINDS.has(job.kind)) {
    return null;
  }
  if (await isBotReady(tenantId, workerSlot)) {
    const key = await getBotWorkerApiKeyDecrypted(tenantId, workerSlot);
    if (key) return key;
  }
  if (job.kind === "railway-publish") {
    const platform = String(process.env.PLATFORM_CURSOR_ADMIN_API_KEY || "").trim();
    if (platform) return platform;
  }
  return null;
}
