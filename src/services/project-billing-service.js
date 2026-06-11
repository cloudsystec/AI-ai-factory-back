import { query } from "../db/pool.js";
import {
  computeForecastCostUsd,
  computePlannedProjectCostUsd,
  estimateTokensFromText,
} from "../lib/billing-preview-estimate.js";
import { resolveProjectScopeMd } from "../lib/resolve-project-scope.js";
import {
  getScopeStateSnapshot,
  getTasksSnapshot,
} from "./project-dashboard-service.js";
import { billingCallDisplayAt, mapCallStatusForUi } from "../lib/billing-display.js";
import { isChargeConfirmed } from "../lib/charge-source.js";

const TERMINAL_TASK_STATUSES = new Set([
  "done",
  "completed",
  "cancelled",
  "failed",
  "merged",
]);

/**
 * @param {unknown[]} tasks
 */
export function countPendingTasks(tasks) {
  return (tasks || []).filter((t) => {
    const status = String(
      t?.status ?? t?.backlogStatus ?? t?.effectiveStatus ?? ""
    ).toLowerCase();
    return status && !TERMINAL_TASK_STATUSES.has(status);
  }).length;
}

/**
 * @param {object|null|undefined} scopeState
 */
export function countPendingMicros(scopeState) {
  if (!scopeState || typeof scopeState !== "object") return 0;
  const microCount = Math.max(0, Number(scopeState.microCount) || 0);
  const approved = Math.max(0, Number(scopeState.microsApproved) || 0);
  return Math.max(0, microCount - approved);
}

/**
 * @param {number} actualUsd
 * @param {number|null|undefined} plannedUsd
 * @param {number} pendingUnits
 * @param {number} plannedUnits
 */
export function forecastFromBilling(actualUsd, plannedUsd, pendingUnits, plannedUnits) {
  return computeForecastCostUsd(actualUsd, plannedUsd, pendingUnits, plannedUnits);
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function getProjectRow(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT slug, name, scope_md,
            planned_cost_usd, planned_cost_meta, planned_cost_at
     FROM projects
     WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, projectSlug]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ microCount: number, taskCount: number }} counts
 */
export async function computeAndStorePlannedCost(tenantId, projectSlug, counts) {
  const microCount = Math.max(0, Number(counts.microCount) || 0);
  if (microCount <= 0) return null;

  const project = await getProjectRow(tenantId, projectSlug);
  if (!project) return null;

  const prevMeta = project.planned_cost_meta || {};
  const prevMicros = Number(prevMeta.microCount) || 0;
  const hasPlanned = project.planned_cost_usd != null;
  if (hasPlanned && microCount <= prevMicros) return null;

  const scopeMd = await resolveProjectScopeMd(tenantId, project);
  const taskCount = Math.max(0, Number(counts.taskCount) || 0);
  const scopeTokensEstimated = estimateTokensFromText(scopeMd);
  const plannedUsd = computePlannedProjectCostUsd(scopeMd, microCount);
  const meta = {
    microCount,
    taskCount,
    scopeTokensEstimated,
    formula: "scope_preview_v1",
  };

  await query(
    `UPDATE projects
     SET planned_cost_usd = $3,
         planned_cost_meta = $4::jsonb,
         planned_cost_at = now()
     WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, projectSlug, plannedUsd, JSON.stringify(meta)]
  );

  return { plannedUsd, meta };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} [limit]
 */
export async function sumActualCostForProject(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(c.cost_base_usd), 0)::numeric AS total
     FROM billing_ai_calls c
     JOIN jobs j ON j.id = c.job_id
     WHERE c.tenant_id = $1 AND j.project_slug = $2
       AND c.source IS DISTINCT FROM 'skipped'`,
    [tenantId, projectSlug]
  );
  return Number(rows[0]?.total) || 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function sumActualCostForProjectToday(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(c.cost_base_usd), 0)::numeric AS total
     FROM billing_ai_calls c
     JOIN jobs j ON j.id = c.job_id
     WHERE c.tenant_id = $1 AND j.project_slug = $2
       AND c.source IS DISTINCT FROM 'skipped'
       AND c.started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [tenantId, projectSlug]
  );
  return Number(rows[0]?.total) || 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function countBillingCallsForProject(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM billing_ai_calls c
     JOIN jobs j ON j.id = c.job_id
     WHERE c.tenant_id = $1 AND j.project_slug = $2
       AND c.source IS DISTINCT FROM 'skipped'`,
    [tenantId, projectSlug]
  );
  return rows[0]?.total || 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} [limit]
 */
export async function listBillingCallsForProject(tenantId, projectSlug, limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await query(
    `SELECT c.id AS execution_id,
            c.job_id,
            c.started_at,
            c.ended_at,
            c.cursor_matched_event_ms,
            c.cost_base_usd,
            c.source AS charge_source,
            c.status,
            c.agent_name,
            u.email AS executor_email
     FROM billing_ai_calls c
     JOIN jobs j ON j.id = c.job_id
     LEFT JOIN users u ON u.id = j.requested_by_user_id
     WHERE c.tenant_id = $1 AND j.project_slug = $2
       AND c.source IS DISTINCT FROM 'skipped'
     ORDER BY COALESCE(c.ended_at, c.started_at) DESC
     LIMIT $3`,
    [tenantId, projectSlug, lim]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getProjectBillingSummary(tenantId, projectSlug) {
  const project = await getProjectRow(tenantId, projectSlug);
  if (!project) return null;

  const [actualCostUsd, scopeState, tasks, events, usageEventsTotal] = await Promise.all([
    sumActualCostForProject(tenantId, projectSlug),
    getScopeStateSnapshot(tenantId, projectSlug),
    getTasksSnapshot(tenantId, projectSlug),
    listBillingCallsForProject(tenantId, projectSlug, 50),
    countBillingCallsForProject(tenantId, projectSlug),
  ]);

  const plannedMeta = project.planned_cost_meta || {};
  const plannedCostUsd =
    project.planned_cost_usd != null ? Number(project.planned_cost_usd) : null;
  const plannedUnits =
    Math.max(0, Number(plannedMeta.microCount) || 0) +
    Math.max(0, Number(plannedMeta.taskCount) || 0);
  const pendingUnits = countPendingMicros(scopeState) + countPendingTasks(tasks);
  const forecastCostUsd = forecastFromBilling(
    actualCostUsd,
    plannedCostUsd,
    pendingUnits,
    plannedUnits
  );

  return {
    projectSlug,
    actualCostUsd,
    plannedCostUsd,
    forecastCostUsd,
    plannedMeta,
    pendingUnits,
    plannedUnits,
    usageEventsTotal,
    recentUsage: events.map((ev) => ({
      execution_id: ev.execution_id,
      job_id: ev.job_id,
      cost_base_usd: Number(ev.cost_base_usd) || 0,
      charge_confirmed: isChargeConfirmed(ev.charge_source),
      status: mapCallStatusForUi(ev.status),
      created_at: billingCallDisplayAt(ev),
      executor_email: ev.executor_email,
      agent_name: ev.agent_name ?? null,
    })),
  };
}
