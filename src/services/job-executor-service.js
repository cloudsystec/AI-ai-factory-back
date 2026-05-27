import { query } from "../db/pool.js";
import { getExecutorCursorApiKeyDecrypted } from "./user-service.js";

/** Jobs que invocam o Cursor CLI (`agent`) — exigem chave de chamada do executor. */
export const CURSOR_AGENT_JOB_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
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
 * Chave Cursor de chamada (por utilizador). Admin API key é separada (tenant).
 * @param {string} tenantId
 * @param {{ kind: string, requested_by_user_id?: string|null, project_slug?: string }} job
 */
export async function resolveCursorApiKeyForJob(tenantId, job) {
  if (job.kind === "provision" || !CURSOR_AGENT_JOB_KINDS.has(job.kind)) {
    return null;
  }
  const userId = await resolveJobExecutorUserId(tenantId, job);
  if (!userId) return null;
  return getExecutorCursorApiKeyDecrypted(userId);
}
