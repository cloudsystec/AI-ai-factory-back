import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { queueJob } from "./job-service.js";

/**
 * @param {object} input
 */
export async function recordTaskPullRequest(input) {
  const {
    tenantId,
    projectSlug,
    taskId,
    jobId,
    microId,
    executorUserId,
    prNumber,
    prUrl,
    headBranch,
    baseBranch,
  } = input;
  await query(
    `INSERT INTO task_pull_requests (
       tenant_id, project_slug, task_id, job_id, micro_id, executor_user_id,
       pr_number, pr_url, head_branch, base_branch, tl_review_status, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',now())
     ON CONFLICT (tenant_id, project_slug, task_id) DO UPDATE SET
       job_id = EXCLUDED.job_id,
       pr_number = EXCLUDED.pr_number,
       pr_url = EXCLUDED.pr_url,
       head_branch = EXCLUDED.head_branch,
       base_branch = EXCLUDED.base_branch,
       tl_review_status = 'pending',
       updated_at = now()`,
    [
      tenantId,
      projectSlug,
      taskId,
      jobId || null,
      microId || null,
      executorUserId || null,
      prNumber,
      prUrl,
      headBranch,
      baseBranch,
    ]
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @param {{ prNumber: number, status: string, summary?: string, mergedAt?: string }} update
 */
export async function updateTaskPrTlReview(
  tenantId,
  projectSlug,
  taskId,
  update
) {
  await query(
    `UPDATE task_pull_requests SET
       tl_review_status = $4,
       tl_summary = COALESCE($5, tl_summary),
       merged_at = COALESCE($6::timestamptz, merged_at),
       updated_at = now()
     WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
    [
      tenantId,
      projectSlug,
      taskId,
      update.status,
      update.summary || null,
      update.mergedAt || null,
    ]
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function listTaskPullRequests(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT task_id, pr_number, pr_url, head_branch, base_branch, tl_review_status,
            tl_summary, merged_at, micro_id, created_at
     FROM task_pull_requests
     WHERE tenant_id = $1 AND project_slug = $2
     ORDER BY created_at DESC`,
    [tenantId, projectSlug]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
export async function getTaskPullRequest(tenantId, projectSlug, taskId) {
  const { rows } = await query(
    `SELECT * FROM task_pull_requests
     WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
    [tenantId, projectSlug, taskId]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export async function allMicroTaskPrsMerged(tenantId, projectSlug, microId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE tl_review_status = 'merged')::int AS merged
     FROM task_pull_requests
     WHERE tenant_id = $1 AND project_slug = $2 AND micro_id = $3`,
    [tenantId, projectSlug, microId]
  );
  const r = rows[0];
  if (!r || r.total === 0) return true;
  return r.total === r.merged;
}

/**
 * PRs mergeadas de todas as tasks do micro exceto a closer.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 * @param {string} closerTaskId
 */
export async function allNonCloserPrsMerged(tenantId, projectSlug, microId, closerTaskId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE tl_review_status = 'merged')::int AS merged
     FROM task_pull_requests
     WHERE tenant_id = $1 AND project_slug = $2 AND micro_id = $3
       AND task_id != $4`,
    [tenantId, projectSlug, microId, closerTaskId]
  );
  const r = rows[0];
  if (!r || r.total === 0) return true;
  return r.total === r.merged;
}

/**
 * Enfileira tech-lead-review após PR da task.
 * @param {string} [requestedByUserId] executor (chave de billing / contexto)
 */
export async function enqueueTechLeadReview(
  tenantId,
  projectSlug,
  taskId,
  prNumber,
  requestedByUserId = null
) {
  const id = randomUUID();
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, task_id, status, payload, requested_by_user_id)
     VALUES ($1, $2, $3, 'tech-lead-review', $4, $5, 'queued', $6::jsonb, $7)`,
    [
      id,
      tenantId,
      projectSlug,
      projectSlug,
      taskId,
      JSON.stringify({ projectSlug, taskId, prNumber }),
      requestedByUserId,
    ]
  );
  await query(
    `UPDATE task_pull_requests SET tl_review_status = 'running', tl_review_job_id = $4, updated_at = now()
     WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
    [tenantId, projectSlug, taskId, id]
  );
  return { jobId: id };
}
