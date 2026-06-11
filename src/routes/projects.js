import { Router } from "express";

import { query } from "../db/pool.js";

import { isValidProjectSlug } from "../lib/project-slug.js";

import { requireActivePlan, requireAuth, attachCapabilities, requirePasswordReady } from "../middleware/auth.js";

import { requireCapability } from "../middleware/permissions.js";

import { queueProvisionJob } from "../services/job-service.js";

import { cloneAgentTemplatesToProject } from "../services/agent-config-service.js";

import { resetProjectPlanning } from "../services/project-reset-service.js";

import {

  assertTenantGitHubConnected,

  validateGitConfigForProject,

  listProjectsWithGit,

  getProjectGitRow,

} from "../services/project-git-service.js";

import {

  createRepository,

  listRepoBranches as ghBranches,

  parseRepoFullName,

  ensureBranchExists,

  ensureBranchHasContent,

  resolveInstallationAccountLogin,

} from "../services/github-app-service.js";

import { listTaskPullRequests } from "../services/task-pr-service.js";

import { getMicroWaveState } from "../services/micro-wave-service.js";
import {
  getProjectMacroScope,
  updateProjectMacroScope,
} from "../services/macro-scope-service.js";

import { approveTaskHumanValidation } from "../services/task-state-service.js";
import { assertProjectCreationReady } from "../services/macro-help-service.js";
import { toPublicProjectGit, isManagedGitRepoMode } from "../lib/project-git-public.js";
import { exportProjectCodeZip } from "../services/project-export-service.js";
import { startGitMigration } from "../services/git-migrate-service.js";
import { startGitDisconnect, getGitDisconnectStatus } from "../services/git-disconnect-service.js";
import {
  getPublishStatus,
  startPublishJob,
} from "../services/project-railway-service.js";



export const projectsRouter = Router();

projectsRouter.use(requireAuth, requirePasswordReady, attachCapabilities, requireActivePlan);



projectsRouter.get("/", async (req, res) => {

  const projects = await listProjectsWithGit(req.user.tenantId);

  res.json(projects);

});



projectsRouter.post("/", requireCapability("write"), async (req, res) => {
  try {
    await assertProjectCreationReady(req.user.tenantId);
  } catch (err) {
    return res.status(err.status || 403).json({
      error: err.message,
      code: err.code ?? undefined,
    });
  }

  const { name, slug, scope, git } = req.body ?? {};

  const trimmedName = String(name ?? "").trim();

  const trimmedSlug = String(slug ?? "").trim();

  const trimmedScope = String(scope ?? "").trim();



  if (!trimmedName) {

    return res.status(400).json({ error: "Nome do projeto é obrigatório." });

  }

  if (!trimmedScope) {

    return res.status(400).json({ error: "Escopo é obrigatório." });

  }

  if (!trimmedSlug) {

    return res.status(400).json({ error: "Slug é obrigatório." });

  }

  if (!isValidProjectSlug(trimmedSlug)) {

    return res.status(400).json({

      error: `Slug inválido: "${trimmedSlug}". Use apenas letras, números, hífen e underscore.`,

    });

  }

  if (!git || !git.mode) {

    const { rows: existing } = await query(
      "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",
      [req.user.tenantId, trimmedSlug]
    );
    if (existing[0]) {
      return res.status(409).json({ error: `Projeto "${trimmedSlug}" já existe.` });
    }

    try {
      await query(
        `INSERT INTO projects (
           tenant_id, slug, name, scope_md, git_status
         ) VALUES ($1, $2, $3, $4, 'not_connected')`,
        [req.user.tenantId, trimmedSlug, trimmedName, trimmedScope]
      );
      await cloneAgentTemplatesToProject(req.user.tenantId, trimmedSlug);
      return res.status(201).json({
        project: trimmedSlug,
        macroId: trimmedSlug,
        name: trimmedName,
        gitStatus: "not_connected",
      });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        await query(
          "DELETE FROM projects WHERE tenant_id = $1 AND slug = $2",
          [req.user.tenantId, trimmedSlug]
        ).catch(() => {});
      }
      return res.status(status).json({ error: error.message });
    }

  }



  const installationId = await assertTenantGitHubConnected(req.user.tenantId);

  let repoFullName = String(git.repoFullName ?? "").trim();

  let repoMode = "existing";



  if (git.mode === "new") {

    const created = await createRepository(installationId, {

      name: String(git.newRepoName ?? "").trim(),

      private: git.isPrivate !== false,

    });

    repoFullName = created.fullName;

    repoMode = "created";

    git.defaultBranch = created.defaultBranch || git.defaultBranch || "main";

  }



  const validated = await validateGitConfigForProject(req.user.tenantId, installationId, {

    ...git,

    repoFullName,

    mode: repoMode === "created" ? "existing" : git.mode,

  });



  const defaultBranch = validated.defaultBranch || String(git.defaultBranch ?? "main").trim();



  const { rows: existing } = await query(

    "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",

    [req.user.tenantId, trimmedSlug]

  );

  if (existing[0]) {

    return res.status(409).json({ error: `Projeto "${trimmedSlug}" já existe.` });

  }



  try {

    await query(

      `INSERT INTO projects (

         tenant_id, slug, name, scope_md,

         github_repo_full_name, github_default_branch, github_tech_lead_branch,

         github_repo_mode, git_status

       ) VALUES ($1, $2, $3, $4, $5, $6, 'tech-lead', $7, 'pending')`,

      [

        req.user.tenantId,

        trimmedSlug,

        trimmedName,

        trimmedScope,

        repoFullName,

        defaultBranch,

        repoMode,

      ]

    );

    await cloneAgentTemplatesToProject(req.user.tenantId, trimmedSlug);

    const queued = await queueProvisionJob(req.user.tenantId, {

      slug: trimmedSlug,

      name: trimmedName,

      scope: trimmedScope,

      git: {

        repoFullName,

        defaultBranch,

        techLeadBranch: "tech-lead",

        repoMode,

      },

    });

    res.status(201).json({

      project: trimmedSlug,

      macroId: trimmedSlug,

      name: trimmedName,

      jobId: queued.jobId,

      gitStatus: "pending",

    });

  } catch (error) {

    const status = error.status || 500;

    if (status >= 500) {

      await query(

        "DELETE FROM projects WHERE tenant_id = $1 AND slug = $2",

        [req.user.tenantId, trimmedSlug]

      ).catch(() => {});

    }

    res.status(status).json({

      error: error.message,

      code: error.code,

    });

  }

});



projectsRouter.post("/:slug/connect-git", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }

  const { installationId, mode, repoFullName: rawRepo, newRepoName, defaultBranch: rawBranch, techLeadBranch: rawTL, isPrivate } = req.body ?? {};

  if (!installationId) {
    return res.status(400).json({ error: "installationId é obrigatório." });
  }
  if (!mode || !["existing", "new"].includes(mode)) {
    return res.status(400).json({ error: "mode deve ser 'existing' ou 'new'." });
  }

  const { rows: projRows } = await query(
    "SELECT git_status, github_repo_mode FROM projects WHERE tenant_id = $1 AND slug = $2",
    [req.user.tenantId, slug]
  );
  if (!projRows[0]) {
    return res.status(404).json({ error: "Projeto não encontrado." });
  }
  if (projRows[0].git_status && projRows[0].git_status !== "not_connected") {
    if (projRows[0].github_repo_mode === "managed") {
      return res.status(409).json({
        error: "Use migrar GitHub para projetos em modo gerenciado.",
        code: "use_migrate_git",
      });
    }
    return res.status(409).json({ error: "Git já conectado neste projeto." });
  }

  try {
    let repoFullName = String(rawRepo ?? "").trim();
    let repoMode = "existing";

    if (mode === "new") {
      const created = await createRepository(Number(installationId), {
        name: String(newRepoName ?? "").trim(),
        private: isPrivate !== false,
      });
      repoFullName = created.fullName;
      repoMode = "created";
    }

    if (!repoFullName) {
      return res.status(400).json({ error: "repoFullName é obrigatório para mode=existing." });
    }

    const parsed = parseRepoFullName(repoFullName);
    if (!parsed) {
      return res.status(400).json({ error: "repoFullName inválido (esperado owner/repo)." });
    }

    const { owner, repo } = parsed;
    const defaultBranch = String(rawBranch ?? "main").trim() || "main";
    const techLeadBranch = String(rawTL ?? "tech-lead").trim() || "tech-lead";

    let accountLogin = null;
    try {
      accountLogin = await resolveInstallationAccountLogin(Number(installationId));
    } catch {}

    await ensureBranchExists(Number(installationId), owner, repo, defaultBranch);
    await ensureBranchHasContent(Number(installationId), owner, repo, defaultBranch);

    if (techLeadBranch !== defaultBranch) {
      await ensureBranchExists(Number(installationId), owner, repo, techLeadBranch, defaultBranch);
      await ensureBranchHasContent(Number(installationId), owner, repo, techLeadBranch);
    }

    await query(
      `UPDATE projects SET
         github_installation_id = $3,
         github_account_login = $4,
         github_connected_at = now(),
         github_repo_full_name = $5,
         github_default_branch = $6,
         github_tech_lead_branch = $7,
         github_repo_mode = $8,
         git_status = 'pending'
       WHERE tenant_id = $1 AND slug = $2`,
      [req.user.tenantId, slug, Number(installationId), accountLogin, repoFullName, defaultBranch, techLeadBranch, repoMode]
    );

    const { rows: projData } = await query(
      "SELECT name, scope_md FROM projects WHERE tenant_id = $1 AND slug = $2",
      [req.user.tenantId, slug]
    );

    const queued = await queueProvisionJob(req.user.tenantId, {
      slug,
      name: projData[0]?.name || slug,
      scope: projData[0]?.scope_md || slug,
      git: { repoFullName, defaultBranch, techLeadBranch, repoMode },
    });

    const { ensureGitProvisionJob } = await import(
      "../services/git-provision-service.js"
    );
    await ensureGitProvisionJob(req.user.tenantId, slug).catch(() => {});

    res.json({
      gitStatus: "provisioning",
      repoFullName,
      defaultBranch,
      techLeadBranch,
      jobId: queued.jobId,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});



projectsRouter.post("/:slug/migrate-git", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const result = await startGitMigration(req.user.tenantId, slug, req.body);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || String(error),
      code: error.code,
    });
  }
});



projectsRouter.post("/:slug/disconnect-git", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const result = await startGitDisconnect(req.user.tenantId, slug);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || String(error),
      code: error.code,
    });
  }
});

projectsRouter.get("/:slug/disconnect-git", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const status = await getGitDisconnectStatus(req.user.tenantId, slug);
    res.json(status);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || String(error),
      code: error.code,
    });
  }
});



projectsRouter.post("/:slug/railway-publish", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const result = await startPublishJob(
      req.user.tenantId,
      slug,
      req.user.id
    );
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || String(error),
      code: error.code,
    });
  }
});



projectsRouter.get("/:slug/railway-publish", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const status = await getPublishStatus(req.user.tenantId, slug);
    res.json(status);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || String(error),
      code: error.code,
    });
  }
});



projectsRouter.get("/:slug/download-code", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  let cleanup = () => {};
  try {
    const { zipPath, fileName, cleanup: fn } = await exportProjectCodeZip(
      req.user.tenantId,
      slug
    );
    cleanup = fn;
    await new Promise((resolve, reject) => {
      res.download(
        zipPath,
        fileName,
        {
          headers: { "Content-Type": "application/zip" },
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: error.message || String(error),
        code: error.code,
      });
    }
  } finally {
    cleanup();
  }
});



/** Rotas com segmentos fixos antes de /:slug (Express 5). */

projectsRouter.get("/:slug/pull-requests", async (req, res) => {

  const slug = String(req.params.slug ?? "").trim();

  if (!isValidProjectSlug(slug)) {

    return res.status(400).json({ error: "Slug inválido" });

  }

  const row = await getProjectGitRow(req.user.tenantId, slug);

  if (!row) return res.status(404).json({ error: "Projeto não encontrado" });

  if (isManagedGitRepoMode(row.github_repo_mode)) {
    return res.json([]);
  }

  const prs = await listTaskPullRequests(req.user.tenantId, slug);

  res.json(

    prs.map((r) => ({

      taskId: r.task_id,

      prNumber: r.pr_number,

      htmlUrl: r.pr_url,

      headBranch: r.head_branch,

      baseBranch: r.base_branch,

      tlReviewStatus: r.tl_review_status,

      microId: r.micro_id,

    }))

  );

});



projectsRouter.get("/:slug/micros/wave", async (req, res) => {

  const slug = String(req.params.slug ?? "").trim();

  if (!isValidProjectSlug(slug)) {

    return res.status(400).json({ error: "Slug inválido" });

  }

  const wave = await getMicroWaveState(req.user.tenantId, slug);

  res.json(wave);

});



projectsRouter.post(

  "/:slug/tasks/:taskId/human-approve",

  requireCapability("write"),

  async (req, res) => {

    const slug = String(req.params.slug ?? "").trim();

    const taskId = String(req.params.taskId ?? "").trim();

    if (!isValidProjectSlug(slug)) {

      return res.status(400).json({ error: "Slug inválido" });

    }

    try {

      const item = approveTaskHumanValidation(

        req.user.tenantId,

        slug,

        taskId

      );

      res.json({ ok: true, task: item });

    } catch (e) {

      res.status(e.status || 500).json({ error: e.message });

    }

  }

);



projectsRouter.post("/:slug/reset", requireCapability("write"), async (req, res) => {

  const slug = String(req.params.slug ?? "").trim();

  if (!isValidProjectSlug(slug)) {

    return res.status(400).json({ error: "Slug inválido" });

  }

  try {

    const result = await resetProjectPlanning(req.user.tenantId, slug);

    res.json(result);

  } catch (error) {

    res.status(error.status || 500).json({

      error: error.message,

      code: error.code,

    });

  }

});


projectsRouter.delete("/:slug", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const { rows } = await query(
      "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",
      [req.user.tenantId, slug]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: "Projeto não encontrado" });
    }
    await resetProjectPlanning(req.user.tenantId, slug).catch(() => {});
    await query("DELETE FROM task_pull_requests WHERE tenant_id = $1 AND project_slug = $2", [req.user.tenantId, slug]).catch(() => {});
    await query("DELETE FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2", [req.user.tenantId, slug]).catch(() => {});
    await query("DELETE FROM jobs WHERE tenant_id = $1 AND project = $2", [req.user.tenantId, slug]).catch(() => {});
    await query("DELETE FROM projects WHERE tenant_id = $1 AND slug = $2", [req.user.tenantId, slug]);
    res.json({ deleted: true, slug });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});



projectsRouter.get("/:slug/macro-scope", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    res.json(await getProjectMacroScope(req.user.tenantId, slug));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

projectsRouter.patch("/:slug/macro-scope", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  const scopeMd = req.body?.scopeMd ?? req.body?.scope;
  if (scopeMd === undefined) {
    return res.status(400).json({ error: "scopeMd é obrigatório" });
  }
  try {
    res.json(await updateProjectMacroScope(req.user.tenantId, slug, scopeMd));
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
    });
  }
});

projectsRouter.get("/:slug", async (req, res) => {

  const slug = String(req.params.slug ?? "").trim();

  if (!isValidProjectSlug(slug)) {

    return res.status(400).json({ error: "Slug inválido" });

  }

  const row = await getProjectGitRow(req.user.tenantId, slug);

  if (!row) return res.status(404).json({ error: "Projeto não encontrado" });

  res.json(toPublicProjectGit(row));

});



projectsRouter.patch("/:slug", requireCapability("write"), async (req, res) => {

  const slug = String(req.params.slug ?? "").trim();

  if (!isValidProjectSlug(slug)) {

    return res.status(400).json({ error: "Slug inválido" });

  }

  const { name, defaultBranch, scopeMd, scope } = req.body ?? {};

  const row = await getProjectGitRow(req.user.tenantId, slug);

  if (!row) return res.status(404).json({ error: "Projeto não encontrado" });

  if (scopeMd !== undefined || scope !== undefined) {
    try {
      const updated = await updateProjectMacroScope(
        req.user.tenantId,
        slug,
        scopeMd ?? scope
      );
      return res.json({
        slug: updated.slug,
        name: updated.name,
        scopeMd: updated.scopeMd,
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: error.message,
        code: error.code,
      });
    }
  }

  const installationId = await assertTenantGitHubConnected(req.user.tenantId);

  const updates = [];

  const params = [req.user.tenantId, slug];

  let i = 3;



  if (name && String(name).trim()) {

    updates.push(`name = $${i++}`);

    params.push(String(name).trim());

  }

  if (defaultBranch && String(defaultBranch).trim()) {

    const parsed = parseRepoFullName(row.github_repo_full_name);

    if (parsed) {

      const branches = await ghBranches(

        installationId,

        parsed.owner,

        parsed.repo

      );

      const db = String(defaultBranch).trim();

      if (!branches.includes(db)) {

        return res.status(400).json({ error: `Branch "${db}" não existe` });

      }

      updates.push(`github_default_branch = $${i++}`);

      params.push(db);

    }

  }



  if (updates.length === 0) {

    return res.status(400).json({ error: "Nada para atualizar" });

  }



  await query(

    `UPDATE projects SET ${updates.join(", ")} WHERE tenant_id = $1 AND slug = $2`,

    params

  );

  const updated = await getProjectGitRow(req.user.tenantId, slug);

  res.json({

    slug: updated.slug,

    name: updated.name,

    defaultBranch: updated.github_default_branch,

    gitStatus: updated.git_status,

  });

});


