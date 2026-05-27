import { Router } from "express";
import { query } from "../db/pool.js";
import { requireWorker } from "../middleware/auth.js";
import {
  getEffectiveAgentConfigForProject,
  listAgentTemplates,
} from "../services/agent-config-service.js";
import { fileForRole } from "../lib/agent-roles.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  appendJobLog,
  claimJob,
  completeJob,
  getGitHubTokenForTenant,
  updateJobBilling,
} from "../services/job-service.js";
import { getProjectGitRow } from "../services/project-git-service.js";
import {
  recordTaskPullRequest,
  enqueueTechLeadReview,
  updateTaskPrTlReview,
} from "../services/task-pr-service.js";
import { setProjectGitStatus } from "../services/project-git-service.js";
import {
  CURSOR_AGENT_JOB_KINDS,
  resolveCursorApiKeyForJob,
  resolveJobExecutorUserId,
} from "../services/job-executor-service.js";
import {
  getDevelopSettings,
  setDevelopSettings,
  upsertDashboardSnapshot,
  upsertTaskDetail,
} from "../services/project-dashboard-service.js";
import { broadcast, registerJobTenant } from "../lib/ws-hub.js";
import { getExecutionState } from "../services/execution-dispatcher-service.js";

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

  const executorUserId = await resolveJobExecutorUserId(
    req.workerTenantId,
    job
  );
  let cursorApiKey = null;
  if (CURSOR_AGENT_JOB_KINDS.has(job.kind)) {
    cursorApiKey = await resolveCursorApiKeyForJob(req.workerTenantId, job);
    if (!cursorApiKey) {
      await completeJob(req.workerTenantId, job.id, {
        status: "failed",
        exitCode: 1,
        costBaseUsd: 0,
      });
      return res.json({
        job: null,
        error: "executor_cursor_key_missing",
        jobId: job.id,
      });
    }
  }

  let githubInstallationToken = null;
  try {
    githubInstallationToken = await getGitHubTokenForTenant(req.workerTenantId);
  } catch {
    githubInstallationToken = null;
  }

  const gitProject = await getProjectGitRow(
    req.workerTenantId,
    job.project_slug
  );
  const taskId = job.task_id;
  const taskBranch = taskId ? `task/${taskId}` : null;

  registerJobTenant(job.id, req.workerTenantId);
  broadcast(req.workerTenantId, {
    type: "job:status",
    jobId: job.id,
    status: "running",
    kind: job.kind,
    project: job.project_slug,
    taskId: job.task_id || null,
  });

  res.json({
    job: {
      id: job.id,
      projectSlug: job.project_slug,
      kind: job.kind,
      macroId: job.macro_id,
      taskId: job.task_id,
      payload: job.payload ?? null,
      requestedByUserId: executorUserId ?? job.requested_by_user_id ?? null,
      requestedByEmail: job.requested_by_email ?? null,
      cursorApiKey,
      githubInstallationToken,
      git: gitProject
        ? {
            repoFullName: gitProject.github_repo_full_name,
            defaultBranch: gitProject.github_default_branch,
            techLeadBranch: gitProject.github_tech_lead_branch || "tech-lead",
            status: gitProject.git_status,
            taskCodePathPattern: taskId ? `tasks/${taskId}/code` : null,
            taskBranch,
          }
        : null,
    },
  });
});

workerRouter.post("/projects/:slug/git/provision-complete", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const { status, error } = req.body ?? {};
  if (status === "ready") {
    await setProjectGitStatus(req.workerTenantId, slug, "ready");
  } else {
    await setProjectGitStatus(
      req.workerTenantId,
      slug,
      "failed",
      error || "provision failed"
    );
  }
  res.json({ ok: true });
});

workerRouter.post("/projects/:slug/git/pr", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const {
    taskId,
    jobId,
    microId,
    executorUserId,
    prNumber,
    prUrl,
    headBranch,
    baseBranch,
  } = req.body ?? {};
  if (!taskId || !prNumber) {
    return res.status(400).json({ error: "taskId e prNumber obrigatórios" });
  }
  await recordTaskPullRequest({
    tenantId: req.workerTenantId,
    projectSlug: slug,
    taskId,
    jobId,
    microId,
    executorUserId,
    prNumber,
    prUrl,
    headBranch: headBranch || `task/${taskId}`,
    baseBranch: baseBranch || "tech-lead",
  });
  const tl = await enqueueTechLeadReview(
    req.workerTenantId,
    slug,
    taskId,
    prNumber,
    executorUserId || null
  );
  res.json({ ok: true, techLeadReviewJobId: tl.jobId });
});

workerRouter.post("/projects/:slug/git/tl-review", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const { taskId, status, summary } = req.body ?? {};
  if (!taskId || !status) {
    return res.status(400).json({ error: "taskId e status obrigatórios" });
  }
  await updateTaskPrTlReview(req.workerTenantId, slug, taskId, {
    status,
    summary: summary || null,
    mergedAt: status === "merged" ? new Date().toISOString() : null,
  });
  broadcast(req.workerTenantId, {
    type: "dashboard",
    project: slug,
    reason: "tl-review",
  });
  res.json({ ok: true });
});

workerRouter.get("/projects/:slug/execution-state", async (req, res) => {
  const slug = req.params.slug;
  if (!slug || !isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "slug inválido" });
  }
  const state = await getExecutionState(req.workerTenantId, slug);
  res.json({
    pauseAfterCurrent: state.pause_after_current === true || state.continuous_active === false,
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

workerRouter.get("/projects/:slug", async (req, res) => {
  const slug = parseSlugParam(req, res);
  if (!slug) return;
  const { rows } = await query(
    `SELECT slug, name, scope_md, github_repo_full_name, github_default_branch,
            github_tech_lead_branch, git_status
     FROM projects
     WHERE tenant_id = $1 AND slug = $2`,
    [req.workerTenantId, slug]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: "Projeto não encontrado" });
  }
  let scopeMd = rows[0].scope_md || "";
  if (!scopeMd.trim()) {
    const { readMacroScopeFromDisk } = await import("../lib/resolve-project-scope.js");
    const fromDisk = readMacroScopeFromDisk(req.workerTenantId, slug);
    if (fromDisk.scopeMd) {
      scopeMd = fromDisk.scopeMd;
    }
  }
  if (!scopeMd.trim()) {
    const { rows: jobs } = await query(
      `SELECT payload FROM jobs
       WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'provision'
       ORDER BY created_at DESC LIMIT 1`,
      [req.workerTenantId, slug]
    );
    const payload = jobs[0]?.payload;
    if (payload && typeof payload === "object" && payload.scope) {
      scopeMd = String(payload.scope);
    }
  }
  res.json({
    slug: rows[0].slug,
    name: rows[0].name,
    scopeMd,
    git: {
      repoFullName: rows[0].github_repo_full_name,
      defaultBranch: rows[0].github_default_branch,
      techLeadBranch: rows[0].github_tech_lead_branch || "tech-lead",
      status: rows[0].git_status,
    },
  });
});

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
  broadcast(req.workerTenantId, { type: "dashboard", project: slug });
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
  const { autorun, skipHumanApproval } = req.body ?? {};
  const settings = await setDevelopSettings(req.workerTenantId, slug, {
    autorun: autorun === true,
    skipHumanApproval: skipHumanApproval === true,
  });
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
  broadcast(req.workerTenantId, { type: "dashboard", project: slug });
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
  registerJobTenant(req.params.id, req.workerTenantId);
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
  broadcast(req.workerTenantId, {
    type: "job:status",
    jobId: req.params.id,
    status: req.body?.status || "succeeded",
    exitCode: req.body?.exitCode ?? null,
  });
  broadcast(req.workerTenantId, { type: "billing" });
  res.json({ ok: true, billing: result });
});

workerRouter.patch("/jobs/:id/billing", async (req, res) => {
  const costBaseUsd = Number(req.body?.costBaseUsd);
  if (!Number.isFinite(costBaseUsd) || costBaseUsd < 0) {
    return res.status(400).json({ error: "costBaseUsd inválido" });
  }
  const { rows } = await query(
    "SELECT tenant_id FROM jobs WHERE id = $1",
    [req.params.id]
  );
  if (!rows[0] || rows[0].tenant_id !== req.workerTenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  const result = await updateJobBilling(req.workerTenantId, req.params.id, {
    costBaseUsd,
  });
  if (!result) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  broadcast(req.workerTenantId, { type: "billing" });
  res.json({ ok: true, billing: result });
});

/**
 * @deprecated Rebuild da imagem ai-factory-cli. Usar GET /worker/projects/:slug/agents.
 * Mantido para workers antigos que ainda fazem sync no startup para tenant/agents/.
 */
workerRouter.get("/tenant-config/agents", async (req, res) => {
  const templates = await listAgentTemplates();
  /** @type {Record<string, string>} */
  const roles = {};
  for (const t of templates) {
    roles[t.role_key] = t.content;
  }
  const files = {};
  for (const [roleKey, content] of Object.entries(roles)) {
    files[fileForRole(roleKey)] = content;
  }
  res.json({
    roles,
    files,
    deprecated: true,
    hint: "Rebuild ai-factory-cli; agentes por projeto em /worker/projects/:slug/agents",
  });
});

workerRouter.get("/projects/:slug/agents", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "slug inválido" });
  }
  const roles = await getEffectiveAgentConfigForProject(
    req.workerTenantId,
    slug
  );
  /** @type {Record<string, string>} */
  const files = {};
  for (const [roleKey, content] of Object.entries(roles)) {
    files[fileForRole(roleKey)] = content;
  }
  res.json({ roles, files, projectSlug: slug });
});

workerRouter.post(
  "/projects/:slug/micros/:microId/enqueue-release",
  async (req, res) => {
    const slug = parseSlugParam(req, res);
    if (!slug) return;
    const microId = req.params.microId;
    const executorUserId = await resolveJobExecutorUserId(req.workerTenantId, {
      project_slug: slug,
      requested_by_user_id: req.body?.executorUserId || null,
    });
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await query(
      `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, payload, requested_by_user_id)
       VALUES ($1, $2, $3, 'micro-release', $4, 'queued', $5::jsonb, $6)`,
      [
        id,
        req.workerTenantId,
        slug,
        slug,
        JSON.stringify({ projectSlug: slug, microId }),
        executorUserId,
      ]
    );
    registerJobTenant(id, req.workerTenantId);
    broadcast(req.workerTenantId, {
      type: "job:status",
      jobId: id,
      status: "queued",
      kind: "micro-release",
    });
    res.json({ jobId: id });
  }
);

workerRouter.post(
  "/projects/:slug/micros/:microId/release-complete",
  async (req, res) => {
    const slug = parseSlugParam(req, res);
    if (!slug) return;
    const microId = req.params.microId;
    const { prNumber, prUrl, status } = req.body ?? {};
    const releaseStatus = status || "open";
    await query(
      `INSERT INTO micro_releases (tenant_id, project_slug, micro_id, release_pr_number, release_pr_url, release_status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, project_slug, micro_id) DO UPDATE SET
         release_pr_number = COALESCE(EXCLUDED.release_pr_number, micro_releases.release_pr_number),
         release_pr_url = COALESCE(EXCLUDED.release_pr_url, micro_releases.release_pr_url),
         release_status = EXCLUDED.release_status,
         merged_at = CASE WHEN EXCLUDED.release_status = 'merged' THEN now() ELSE micro_releases.merged_at END,
         updated_at = now()`,
      [req.workerTenantId, slug, microId, prNumber || null, prUrl || null, releaseStatus]
    );
    broadcast(req.workerTenantId, {
      type: "dashboard",
      project: slug,
      reason: "micro-release",
    });
    res.json({ ok: true });
  }
);

workerRouter.post("/heartbeat", async (req, res) => {
  await query(
    "UPDATE tenant_workers SET last_heartbeat = now() WHERE tenant_id = $1",
    [req.workerTenantId]
  );
  res.json({ ok: true });
});
