import { Router } from "express";
import { isChargeConfirmed } from "../lib/charge-source.js";
import {
  billingCallDisplayAt,
  mapCallStatusForUi,
} from "../lib/billing-display.js";
import { requireActivePlan, requireAuth, attachCapabilities } from "../middleware/auth.js";
import {
  countBillingCallsForTenant,
  listRecentBillingCalls,
} from "../services/billing-call-service.js";
import { getProjectBillingSummary } from "../services/project-billing-service.js";
import { getUsageEventsPayload } from "../services/billing-usage-service.js";
import { listActiveJobsForTenant } from "../services/job-service.js";
import { getTenantUserQuota } from "../services/user-service.js";
import { listWorkersStatus } from "../services/worker-bot-service.js";

export const billingRouter = Router();
billingRouter.use(requireAuth, attachCapabilities, requireActivePlan);

billingRouter.get("/summary", async (req, res) => {
  const t = req.tenant;
  const pool = Number(t.pool_credit_cycle_usd);
  const balance = Number(t.balance_usd);
  const used = Math.max(0, pool - balance);
  const pct = pool > 0 ? Math.round((used / pool) * 100) : 0;

  const [events, usageEventsTotal] = await Promise.all([
    listRecentBillingCalls(req.user.tenantId, 50),
    countBillingCallsForTenant(req.user.tenantId),
  ]);
  const cotation = Number(t.cotation) || 5.1;

  const quota = await getTenantUserQuota(req.user.tenantId);
  const workersStatus = await listWorkersStatus(req.user.tenantId);
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
    workerSlot: row.worker_slot ?? null,
  }));

  res.json({
    planId: t.plan_id,
    cotation,
    balanceUsd: balance,
    poolCreditCycleUsd: pool,
    usedUsd: used,
    usedPercent: pct,
    agentSlotsMax: t.agent_slots_max,
    agentSlotsInUse: t.agent_slots_in_use,
    usersMax: quota?.usersMax ?? t.users_max,
    usersUsed: quota?.usersUsed ?? 0,
    workerStatus: t.worker_status,
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
    activeJobs,
    workersStatus: workersStatus.workers,
    slotsMax: workersStatus.slotsMax,
  });
});

billingRouter.get("/usage-events", async (req, res) => {
  const agent = req.query.agent;
  const payload = await getUsageEventsPayload({
    tenantId: req.user.tenantId,
    agentFilter: agent,
  });
  const t = req.tenant;
  res.json({
    ...payload,
    cotation: Number(t.cotation) || 5.1,
  });
});

billingRouter.get("/projects/:slug/usage-events", async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) {
    return res.status(400).json({ error: "slug obrigatório" });
  }
  const agent = req.query.agent;
  const payload = await getUsageEventsPayload({
    tenantId: req.user.tenantId,
    projectSlug: slug,
    agentFilter: agent,
  });
  const t = req.tenant;
  res.json({
    ...payload,
    projectSlug: slug,
    cotation: Number(t.cotation) || 5.1,
  });
});

billingRouter.get("/projects/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) {
    return res.status(400).json({ error: "slug obrigatório" });
  }

  const summary = await getProjectBillingSummary(req.user.tenantId, slug);
  if (!summary) {
    return res.status(404).json({ error: "Projeto não encontrado" });
  }

  const t = req.tenant;
  res.json({
    ...summary,
    cotation: Number(t.cotation) || 5.1,
  });
});
