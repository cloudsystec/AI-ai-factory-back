import { Router } from "express";
import { query } from "../db/pool.js";
import { requireActivePlan, requireAuth, attachCapabilities } from "../middleware/auth.js";
import { listActiveJobsForTenant } from "../services/job-service.js";
import { getTenantUserQuota } from "../services/user-service.js";

export const billingRouter = Router();
billingRouter.use(requireAuth, attachCapabilities, requireActivePlan);

billingRouter.get("/summary", async (req, res) => {
  const t = req.tenant;
  const pool = Number(t.pool_credit_cycle_usd);
  const balance = Number(t.balance_usd);
  const used = Math.max(0, pool - balance);
  const pct = pool > 0 ? Math.round((used / pool) * 100) : 0;

  const { rows: events } = await query(
    `SELECT ue.execution_id, ue.job_id, ue.cost_base_usd, ue.charge_usd, ue.status,
            ue.created_at, ue.executor_email
     FROM usage_events ue
     WHERE ue.tenant_id = $1
     ORDER BY ue.created_at DESC
     LIMIT 20`,
    [req.user.tenantId]
  );

  const quota = await getTenantUserQuota(req.user.tenantId);
  const activeRows = await listActiveJobsForTenant(req.user.tenantId);
  const activeJobs = activeRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    project: row.project_slug,
    macroId: row.macro_id ?? null,
    taskId: row.task_id ?? null,
    status: row.status,
    startedAt: row.started_at,
    executorEmail: row.executor_email ?? null,
  }));

  res.json({
    planId: t.plan_id,
    balanceUsd: balance,
    poolCreditCycleUsd: pool,
    usedUsd: used,
    usedPercent: pct,
    agentSlotsMax: t.agent_slots_max,
    agentSlotsInUse: t.agent_slots_in_use,
    usersMax: quota?.usersMax ?? t.users_max,
    usersUsed: quota?.usersUsed ?? 0,
    workerStatus: t.worker_status,
    recentUsage: events,
    activeJobs,
  });
});
