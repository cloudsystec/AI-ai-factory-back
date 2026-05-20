import { query } from "../db/pool.js";

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getTasksSnapshot(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT tasks_json FROM project_dashboard_snapshots
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  if (!rows[0]?.tasks_json) return [];
  const data = rows[0].tasks_json;
  return Array.isArray(data) ? data : [];
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getScopeStateSnapshot(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT scope_state_json FROM project_dashboard_snapshots
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return rows[0]?.scope_state_json ?? null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getDevelopSettings(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT autorun FROM project_develop_settings
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return { autorun: rows[0]?.autorun === true };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {boolean} autorun
 */
export async function setDevelopSettings(tenantId, projectSlug, autorun) {
  await query(
    `INSERT INTO project_develop_settings (tenant_id, project_slug, autorun, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       autorun = EXCLUDED.autorun,
       updated_at = now()`,
    [tenantId, projectSlug, autorun]
  );
  return getDevelopSettings(tenantId, projectSlug);
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
export async function getTaskDetail(tenantId, projectSlug, taskId) {
  const { rows } = await query(
    `SELECT detail_json FROM project_task_details
     WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
    [tenantId, projectSlug, taskId]
  );
  return rows[0]?.detail_json ?? null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {unknown} tasks
 * @param {unknown} scopeState
 */
export async function upsertDashboardSnapshot(tenantId, projectSlug, tasks, scopeState) {
  await query(
    `INSERT INTO project_dashboard_snapshots
       (tenant_id, project_slug, tasks_json, scope_state_json, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       tasks_json = EXCLUDED.tasks_json,
       scope_state_json = EXCLUDED.scope_state_json,
       updated_at = now()`,
    [
      tenantId,
      projectSlug,
      JSON.stringify(tasks ?? []),
      scopeState == null ? null : JSON.stringify(scopeState),
    ]
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @param {unknown} detail
 */
export async function upsertTaskDetail(tenantId, projectSlug, taskId, detail) {
  await query(
    `INSERT INTO project_task_details
       (tenant_id, project_slug, task_id, detail_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (tenant_id, project_slug, task_id) DO UPDATE SET
       detail_json = EXCLUDED.detail_json,
       updated_at = now()`,
    [tenantId, projectSlug, taskId, JSON.stringify(detail)]
  );
}
