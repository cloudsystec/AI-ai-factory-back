import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import {
  assertTenantGitHubConnected,
  getProjectGitRow,
  validateGitConfigForProject,
} from "./project-git-service.js";
import { pauseContinuousExecution } from "./execution-dispatcher-service.js";
import { getProjectStatus } from "./project-completion-service.js";
import {
  createRepository,
  parseRepoFullName,
  resolveInstallationAccountLogin,
} from "./github-app-service.js";

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {object} body
 */
export async function startGitMigration(tenantId, slug, body) {
  const row = await getProjectGitRow(tenantId, slug);
  if (!row) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
  if (row.github_repo_mode !== "managed") {
    throw Object.assign(
      new Error("Migração só disponível para projetos sem GitHub do cliente."),
      { status: 409, code: "not_managed" }
    );
  }
  if (row.git_status !== "ready") {
    throw Object.assign(
      new Error("Aguarde o workspace ficar pronto antes de conectar GitHub."),
      { status: 409, code: "git_not_ready" }
    );
  }

  const projectStatus = await getProjectStatus(tenantId, slug);
  if (projectStatus.status === "completed") {
    throw Object.assign(
      new Error("Projeto finalizado — migração Git não permitida."),
      { status: 403, code: "project_completed" }
    );
  }

  const installationId = await assertTenantGitHubConnected(tenantId);
  const {
    mode,
    repoFullName: rawRepo,
    newRepoName,
    defaultBranch: rawBranch,
    techLeadBranch: rawTL,
    isPrivate,
  } = body ?? {};

  if (!mode || !["existing", "new"].includes(mode)) {
    throw Object.assign(new Error("mode deve ser 'existing' ou 'new'."), {
      status: 400,
    });
  }

  let repoFullName = String(rawRepo ?? "").trim();
  if (mode === "new") {
    const created = await createRepository(Number(installationId), {
      name: String(newRepoName ?? "").trim(),
      private: isPrivate !== false,
    });
    repoFullName = created.fullName;
  }
  if (!repoFullName) {
    throw Object.assign(new Error("repoFullName é obrigatório."), {
      status: 400,
    });
  }

  const parsed = parseRepoFullName(repoFullName);
  if (!parsed) {
    throw Object.assign(new Error("repoFullName inválido (owner/repo)."), {
      status: 400,
    });
  }

  const defaultBranch = String(rawBranch ?? "main").trim() || "main";
  const techLeadBranch = String(rawTL ?? "tech-lead").trim() || "tech-lead";

  await validateGitConfigForProject(tenantId, installationId, {
    mode: "existing",
    repoFullName,
    defaultBranch,
  });

  let accountLogin = null;
  try {
    accountLogin = await resolveInstallationAccountLogin(Number(installationId));
  } catch {
    /* ignore */
  }

  await pauseContinuousExecution(tenantId, slug);

  const managedRepo = row.github_repo_full_name;

  await query(
    `UPDATE projects SET
       github_managed_repo_full_name = COALESCE(github_managed_repo_full_name, $3),
       github_installation_id = $4,
       github_account_login = $5,
       github_connected_at = now(),
       github_repo_full_name = $6,
       github_default_branch = $7,
       github_tech_lead_branch = $8,
       github_repo_mode = 'client',
       git_status = 'migrating',
       git_last_error = NULL,
       updated_at = now()
     WHERE tenant_id = $1 AND slug = $2`,
    [
      tenantId,
      slug,
      managedRepo,
      Number(installationId),
      accountLogin,
      repoFullName,
      defaultBranch,
      techLeadBranch,
    ]
  );

  const jobId = randomUUID();
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, status, payload)
     VALUES ($1, $2, $3, 'git-migrate', 'queued', $4::jsonb)`,
    [
      jobId,
      tenantId,
      slug,
      JSON.stringify({
        slug,
        managedRepoFullName: managedRepo,
        repoFullName,
        defaultBranch,
        techLeadBranch,
        sourceTechLead: row.github_tech_lead_branch || "tech-lead",
      }),
    ]
  );

  log.info("Migração Git enfileirada", { tenantId, project: slug, jobId });

  return {
    jobId,
    gitStatus: "migrating",
    repoFullName,
    defaultBranch,
    techLeadBranch,
  };
}

/**
 * Re-enfileira git-migrate se pendente.
 * @param {string} tenantId
 * @param {string} slug
 */
export async function ensureGitMigrateJob(tenantId, slug) {
  const gitRow = await getProjectGitRow(tenantId, slug);
  if (!gitRow || gitRow.git_status !== "migrating") return null;

  const { rows } = await query(
    `SELECT 1 FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'git-migrate'
       AND status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, slug]
  );
  if (rows.length > 0) return null;

  const jobId = randomUUID();
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, status, payload)
     VALUES ($1, $2, $3, 'git-migrate', 'queued', $4::jsonb)`,
    [
      jobId,
      tenantId,
      slug,
      JSON.stringify({
        slug,
        managedRepoFullName: gitRow.github_managed_repo_full_name,
        repoFullName: gitRow.github_repo_full_name,
        defaultBranch: gitRow.github_default_branch || "main",
        techLeadBranch: gitRow.github_tech_lead_branch || "tech-lead",
        sourceTechLead: gitRow.github_tech_lead_branch || "tech-lead",
      }),
    ]
  );
  return { jobId };
}
