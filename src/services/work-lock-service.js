import { query } from "../db/pool.js";

/**
 * @param {string} tenantId
 * @param {string} kind
 * @param {string} projectSlug
 * @param {string} [taskId]
 * @param {string} [macroId]
 * @param {object} [payload]
 */
export function resolveLockForJob(kind, projectSlug, taskId, macroId, payload) {
  switch (kind) {
    case "scope":
      return { lockKind: "scope", lockKey: `${projectSlug}:${macroId || projectSlug}` };
    case "scope-tasks-only": {
      const microId = payload?.microId || macroId;
      return { lockKind: "micro_tasks", lockKey: `${projectSlug}:${microId}` };
    }
    case "task":
      return { lockKind: "task", lockKey: `${projectSlug}:${taskId}` };
    case "develop":
      return { lockKind: "develop", lockKey: projectSlug };
    default:
      return null;
  }
}

/**
 * @param {string} tenantId
 * @param {string} lockKind
 * @param {string} lockKey
 */
export async function isLockFree(tenantId, lockKind, lockKey, client = null) {
  const run = client
    ? (sql, params) => client.query(sql, params)
    : (sql, params) => query(sql, params);
  const { rows } = await run(
    `SELECT 1 FROM work_locks WHERE tenant_id = $1 AND lock_kind = $2 AND lock_key = $3`,
    [tenantId, lockKind, lockKey]
  );
  return rows.length === 0;
}

/**
 * @param {import('pg').PoolClient} client
 */
export async function acquireWorkLock(client, tenantId, projectSlug, lockKind, lockKey, jobId, workerSlot) {
  await client.query(
    `INSERT INTO work_locks (tenant_id, project_slug, lock_kind, lock_key, job_id, worker_slot)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, projectSlug, lockKind, lockKey, jobId, workerSlot]
  );
}

/**
 * @param {string} jobId
 */
export async function releaseWorkLocksForJob(jobId) {
  await query(`DELETE FROM work_locks WHERE job_id = $1`, [jobId]);
}
