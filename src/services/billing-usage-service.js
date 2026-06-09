import { query } from "../db/pool.js";
import { billingCallDisplayAt, mapCallStatusForUi } from "../lib/billing-display.js";
import { isChargeConfirmed } from "../lib/charge-source.js";

const MAX_USAGE_EVENTS = 5000;

/**
 * @param {string|null|undefined} agentFilter
 */
export function normalizeAgentFilter(agentFilter) {
  const raw = String(agentFilter ?? "").trim();
  if (!raw || raw === "all") return null;
  if (raw === "__none__") return "__none__";
  return raw;
}

/**
 * @param {string|null|undefined} agentName
 */
export function agentFilterLabel(agentName) {
  const s = String(agentName ?? "").trim();
  return s || "Sem agente";
}

/**
 * @param {{
 *   tenantId: string,
 *   projectSlug?: string|null,
 *   agentFilter?: string|null,
 * }} scope
 */
function buildScope(scope) {
  const tenantId = scope.tenantId;
  const projectSlug = scope.projectSlug
    ? String(scope.projectSlug).trim()
    : null;
  const agentFilter = normalizeAgentFilter(scope.agentFilter);

  const params = [tenantId];
  let projectJoin = "";
  let where = `c.tenant_id = $1 AND c.source IS DISTINCT FROM 'skipped'`;

  if (projectSlug) {
    params.push(projectSlug);
    projectJoin = "JOIN jobs j ON j.id = c.job_id";
    where += ` AND j.project_slug = $${params.length}`;
  }

  if (agentFilter === "__none__") {
    where += " AND (c.agent_name IS NULL OR TRIM(c.agent_name) = '')";
  } else if (agentFilter) {
    params.push(agentFilter);
    where += ` AND c.agent_name = $${params.length}`;
  }

  return { params, projectJoin, where };
}

/**
 * @param {object} row
 */
export function mapBillingCallRowForUi(row) {
  return {
    execution_id: row.execution_id,
    job_id: row.job_id,
    cost_base_usd: Number(row.cost_base_usd) || 0,
    charge_confirmed: isChargeConfirmed(row.charge_source),
    status: mapCallStatusForUi(row.status),
    created_at: billingCallDisplayAt(row),
    executor_email: row.executor_email ?? null,
    agent_name: row.agent_name ?? null,
  };
}

/**
 * @param {{
 *   tenantId: string,
 *   projectSlug?: string|null,
 *   agentFilter?: string|null,
 * }} input
 */
export async function getUsageStats(input) {
  const { params, projectJoin, where } = buildScope(input);
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS total_count,
       COALESCE(SUM(c.cost_base_usd), 0)::numeric AS total_cost_usd,
       COUNT(*) FILTER (WHERE c.source = 'cursor_admin_api')::int AS confirmed_count,
       COUNT(*) FILTER (WHERE c.source IS DISTINCT FROM 'cursor_admin_api')::int AS estimated_count
     FROM billing_ai_calls c
     ${projectJoin}
     WHERE ${where}`,
    params
  );
  const row = rows[0] || {};
  return {
    totalCount: row.total_count || 0,
    totalCostUsd: Number(row.total_cost_usd) || 0,
    confirmedCount: row.confirmed_count || 0,
    estimatedCount: row.estimated_count || 0,
  };
}

/**
 * @param {{
 *   tenantId: string,
 *   projectSlug?: string|null,
 * }} input
 */
export async function listUsageAgents(input) {
  const { params, projectJoin, where } = buildScope({
    ...input,
    agentFilter: null,
  });
  const { rows } = await query(
    `SELECT
       COALESCE(NULLIF(TRIM(c.agent_name), ''), '__none__') AS agent_key,
       COALESCE(NULLIF(TRIM(c.agent_name), ''), 'Sem agente') AS agent_name,
       COUNT(*)::int AS count,
       COALESCE(SUM(c.cost_base_usd), 0)::numeric AS total_cost_usd,
       COUNT(*) FILTER (WHERE c.source = 'cursor_admin_api')::int AS confirmed_count,
       COUNT(*) FILTER (WHERE c.source IS DISTINCT FROM 'cursor_admin_api')::int AS estimated_count
     FROM billing_ai_calls c
     ${projectJoin}
     WHERE ${where}
     GROUP BY 1, 2
     ORDER BY total_cost_usd DESC, agent_name ASC`,
    params
  );
  return rows.map((r) => ({
    agentKey: r.agent_key,
    agentName: r.agent_name,
    count: r.count || 0,
    totalCostUsd: Number(r.total_cost_usd) || 0,
    confirmedCount: r.confirmed_count || 0,
    estimatedCount: r.estimated_count || 0,
  }));
}

/**
 * @param {{
 *   tenantId: string,
 *   projectSlug?: string|null,
 *   agentFilter?: string|null,
 *   limit?: number,
 * }} input
 */
export async function listUsageEvents(input) {
  const lim = Math.min(
    Math.max(Number(input.limit) || MAX_USAGE_EVENTS, 1),
    MAX_USAGE_EVENTS
  );
  const { params, projectJoin, where } = buildScope(input);
  params.push(lim);

  const jobsJoin = projectJoin || "LEFT JOIN jobs j ON j.id = c.job_id";

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
     ${jobsJoin}
     LEFT JOIN users u ON u.id = j.requested_by_user_id
     WHERE ${where}
     ORDER BY COALESCE(c.ended_at, c.started_at) DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/**
 * @param {{
 *   tenantId: string,
 *   projectSlug?: string|null,
 *   agentFilter?: string|null,
 * }} input
 */
export async function getUsageEventsPayload(input) {
  const [stats, agents, rawEvents] = await Promise.all([
    getUsageStats(input),
    listUsageAgents(input),
    listUsageEvents(input),
  ]);
  return {
    stats,
    agents,
    events: rawEvents.map(mapBillingCallRowForUi),
    eventsLimit: MAX_USAGE_EVENTS,
    eventsTruncated: stats.totalCount > rawEvents.length,
  };
}
