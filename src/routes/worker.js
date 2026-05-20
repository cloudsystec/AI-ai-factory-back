import { Router } from "express";
import { query } from "../db/pool.js";
import { requireWorker } from "../middleware/auth.js";
import { getEffectiveAgentConfigForTenant } from "../services/agent-config-service.js";
import { fileForRole } from "../lib/agent-roles.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  appendJobLog,
  claimJob,
  completeJob,
} from "../services/job-service.js";
import {
  getDevelopSettings,
  setDevelopSettings,
  upsertDashboardSnapshot,
  upsertTaskDetail,
} from "../services/project-dashboard-service.js";

export const workerRouter = Router();
workerRouter.use(requireWorker);

workerRouter.post("/register", async (req, res) => {
  const tenantId = req.workerTenantId;
  const { rows } = await query(
    "SELECT id, plan_active_until FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: "Tenant não encontrado" });
  }
  if (new Date(rows[0].plan_active_until) < new Date()) {
    return res.status(403).json({ code: "plan_inactive" });
  }
  const workerId = req.body?.workerId || `worker-${tenantId.slice(0, 8)}`;
  await query(
    `INSERT INTO tenant_workers (tenant_id, worker_id, last_heartbeat)
     VALUES ($1, $2, now())
     ON CONFLICT (tenant_id) DO UPDATE SET worker_id = $2, last_heartbeat = now()`,
    [tenantId, workerId]
  );
  await query(
    "UPDATE tenants SET worker_status = 'online', updated_at = now() WHERE id = $1",
    [tenantId]
  );
  res.json({ ok: true, workerId });
});

workerRouter.post("/claim", async (req, res) => {
  if (req.workerTenantId !== req.headers["x-tenant-id"]) {
    return res.status(403).json({ error: "Tenant mismatch" });
  }
  const workerId = req.body?.workerId || "default";
  const job = await claimJob(req.workerTenantId, workerId);
  if (!job) return res.json({ job: null });
  res.json({
    job: {
      id: job.id,
      projectSlug: job.project_slug,
      kind: job.kind,
      macroId: job.macro_id,
      taskId: job.task_id,
      payload: job.payload ?? null,
    },
  });
});

function parseSlugParam(req, res) {
  const slug = req.params.slug;
  if (!slug || !isValidProjectSlug(slug)) {
    res.status(400).json({ error: "slug inválido" });
    return null;
  }
  return slug;
}

workerRouter.put("/projects/:slug/dashboard", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const { tasks, scopeState } = req.body ?? {};
  await upsertDashboardSnapshot(
    req.workerTenantId,
    slug,
    tasks ?? [],
    scopeState ?? null
  );
  res.json({ ok: true });
});

workerRouter.get("/projects/:slug/develop-settings", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  res.json(await getDevelopSettings(req.workerTenantId, slug));
});

workerRouter.put("/projects/:slug/develop-settings", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const { autorun } = req.body ?? {};
  if (typeof autorun !== "boolean") {
    return res.status(400).json({ error: "autorun boolean obrigatório" });
  }
  const settings = await setDevelopSettings(req.workerTenantId, slug, autorun);
  res.json(settings);
});

workerRouter.put("/projects/:slug/tasks/:taskId/detail", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const taskId = req.params.taskId;
  if (!taskId || typeof taskId !== "string") {
    return res.status(400).json({ error: "taskId obrigatório" });
  }
  const { detail } = req.body ?? {};
  if (detail == null) {
    return res.status(400).json({ error: "detail obrigatório" });
  }
  await upsertTaskDetail(req.workerTenantId, slug, taskId, detail);
  res.json({ ok: true });
});

workerRouter.post("/jobs/:id/log", async (req, res) => {
  const line = req.body?.line ?? req.body?.text;
  if (typeof line !== "string") {
    return res.status(400).json({ error: "line obrigatório" });
  }
  const { rows } = await query(
    "SELECT tenant_id FROM jobs WHERE id = $1",
    [req.params.id]
  );
  if (!rows[0] || rows[0].tenant_id !== req.workerTenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  await appendJobLog(req.params.id, line);
  res.json({ ok: true });
});

workerRouter.post("/jobs/:id/complete", async (req, res) => {
  const { rows } = await query(
    "SELECT tenant_id FROM jobs WHERE id = $1",
    [req.params.id]
  );
  if (!rows[0] || rows[0].tenant_id !== req.workerTenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  const result = await completeJob(req.workerTenantId, req.params.id, {
    status: req.body?.status || "succeeded",
    costBaseUsd: req.body?.costBaseUsd,
    exitCode: req.body?.exitCode,
  });
  res.json({ ok: true, billing: result });
});

workerRouter.get("/tenant-config/agents", async (req, res) => {
  const roles = await getEffectiveAgentConfigForTenant(req.workerTenantId);
  /** @type {Record<string, string>} */
  const files = {};
  for (const [roleKey, content] of Object.entries(roles)) {
    files[fileForRole(roleKey)] = content;
  }
  res.json({ roles, files });
});

workerRouter.post("/heartbeat", async (req, res) => {
  await query(
    "UPDATE tenant_workers SET last_heartbeat = now() WHERE tenant_id = $1",
    [req.workerTenantId]
  );
  res.json({ ok: true });
});
