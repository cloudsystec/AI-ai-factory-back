import { query } from "../db/pool.js";
import {
  listRepoBranches,
  getRepoDefaultBranch,
  parseRepoFullName,
  resolveInstallationAccountLogin,
} from "./github-app-service.js";

/**
 * @param {string} tenantId
 */
export async function assertTenantGitHubConnected(tenantId) {
  const { rows } = await query(
    `SELECT github_installation_id FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!rows[0]?.github_installation_id) {
    throw Object.assign(
      new Error("Conta GitHub não ligada. Conecte GitHub no portal."),
      { status: 400, code: "github_not_connected" }
    );
  }
  return rows[0].github_installation_id;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function assertProjectGitReady(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT git_status, git_last_error FROM projects
     WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, projectSlug]
  );
  const p = rows[0];
  if (!p) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
  if (p.git_status !== "ready") {
    throw Object.assign(
      new Error(
        p.git_last_error ||
          "Projeto sem repositório Git pronto. Conclua o provisionamento ou corrija a ligação."
      ),
      { status: 400, code: "git_not_ready" }
    );
  }
}

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function getProjectGitRow(tenantId, slug) {
  const { rows } = await query(
    `SELECT slug, name, scope_md, github_repo_full_name, github_default_branch,
            github_tech_lead_branch, github_repo_mode, git_status, git_last_error,
            created_at
     FROM projects WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 */
export async function listProjectsWithGit(tenantId) {
  const { rows } = await query(
    `SELECT slug, name, github_default_branch, github_repo_full_name,
            git_status, github_tech_lead_branch, created_at
     FROM projects WHERE tenant_id = $1 ORDER BY slug`,
    [tenantId]
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    defaultBranch: r.github_default_branch,
    techLeadBranch: r.github_tech_lead_branch,
    repoFullName: r.github_repo_full_name,
    gitStatus: r.git_status,
    createdAt: r.created_at,
  }));
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {'ready'|'failed'|'provisioning'|'pending'} status
 * @param {string} [error]
 */
export async function setProjectGitStatus(tenantId, slug, status, error = null) {
  await query(
    `UPDATE projects SET git_status = $3, git_last_error = $4
     WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug, status, error]
  );
}

/**
 * @param {string} tenantId
 * @param {bigint} installationId
 * @param {{ mode: string, repoFullName?: string, newRepoName?: string, defaultBranch: string, isPrivate?: boolean }} git
 */
export async function validateGitConfigForProject(tenantId, installationId, git) {
  const mode = git.mode;
  const defaultBranch = String(git.defaultBranch || "").trim();
  if (!defaultBranch) {
    throw Object.assign(new Error("Branch default é obrigatória"), { status: 400 });
  }

  if (mode === "existing") {
    const full = String(git.repoFullName || "").trim();
    const parsed = parseRepoFullName(full);
    if (!parsed) {
      throw Object.assign(new Error("repoFullName inválido (org/repo)"), {
        status: 400,
      });
    }
    const branches = await listRepoBranches(
      installationId,
      parsed.owner,
      parsed.repo
    );
    let resolvedBranch = defaultBranch;
    if (branches.length === 0) {
      resolvedBranch = defaultBranch || "main";
    } else if (!branches.includes(defaultBranch)) {
      const repoDef = await getRepoDefaultBranch(installationId, parsed.owner, parsed.repo);
      resolvedBranch = branches.includes(repoDef) ? repoDef : branches[0];
    }
    return { repoFullName: full, repoMode: "existing", defaultBranch: resolvedBranch };
  }

  if (mode === "new") {
    const name = String(git.newRepoName || "").trim();
    if (!name) {
      throw Object.assign(new Error("newRepoName é obrigatório"), { status: 400 });
    }
    return { newRepoName: name, repoMode: "created", defaultBranch };
  }

  throw Object.assign(new Error("git.mode deve ser existing ou new"), { status: 400 });
}

export async function connectInstallationToTenant(tenantId, installationId) {
  const login = await resolveInstallationAccountLogin(installationId);
  await query(
    `UPDATE tenants SET github_installation_id = $2, github_account_login = $3,
     github_connected_at = now(), updated_at = now() WHERE id = $1`,
    [tenantId, installationId, login]
  );
  return { login };
}

/**
 * Só true se a instalação existir e a API GitHub responder (token + GET installation).
 * @param {string} tenantId
 */
export async function isTenantGitHubReady(tenantId) {
  const { rows } = await query(
    `SELECT github_installation_id FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const installationId = rows[0]?.github_installation_id;
  if (!installationId) return false;
  try {
    await resolveInstallationAccountLogin(installationId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove ligação GitHub incompleta (ex. PEM inválido após callback).
 * @param {string} tenantId
 */
export async function clearTenantGitHubConnection(tenantId) {
  await query(
    `UPDATE tenants SET github_installation_id = NULL, github_account_login = NULL,
     github_connected_at = NULL, updated_at = now() WHERE id = $1`,
    [tenantId]
  );
}
