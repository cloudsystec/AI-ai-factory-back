import { Router } from "express";
import { query } from "../db/pool.js";
import { requireActivePlan, requireAuth } from "../middleware/auth.js";

export const billingRouter = Router();
billingRouter.use(requireAuth, requireActivePlan);

billingRouter.get("/summary", async (req, res) => {
  const t = req.tenant;
  const pool = Number(t.pool_credit_cycle_usd);
  const balance = Number(t.balance_usd);
  const used = Math.max(0, pool - balance);
  const pct = pool > 0 ? Math.round((used / pool) * 100) : 0;

  const { rows: events } = await query(
    `SELECT execution_id, job_id, cost_base_usd, charge_usd, status, created_at
     FROM usage_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [req.user.tenantId]
  );

  res.json({
    planId: t.plan_id,
    balanceUsd: balance,
    poolCreditCycleUsd: pool,
    usedUsd: used,
    usedPercent: pct,
    agentSlotsMax: t.agent_slots_max,
    agentSlotsInUse: t.agent_slots_in_use,
    workerStatus: t.worker_status,
    recentUsage: events,
  });
});
