import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import {
  createRepository,
  getInstallationAccessToken,
  resolveInstallationAccountLogin,
} from "./github-app-service.js";
import {
  assertPlatformGitConfigured,
  getPlatformInstallationId,
} from "./managed-git-service.js";
import { getProjectGitRow } from "./project-git-service.js";

const DEFAULT_DEPLOY_PREFIX = "df-deploy";

export function getDeployRepoPrefix() {
  return (
    String(process.env.GITHUB_DEPLOY_REPO_PREFIX || DEFAULT_DEPLOY_PREFIX).trim() ||
    DEFAULT_DEPLOY_PREFIX
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function buildDeployRepoName(tenantId, projectSlug) {
  const prefix = getDeployRepoPrefix();
  const tenantShort = String(tenantId).replace(/-/g, "").slice(0, 8).toLowerCase();
  const slug = String(projectSlug)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  let name = `${prefix}-${tenantShort}-${slug}`;
  if (name.length > 100) {
    name = name.slice(0, 100);
  }
  return name;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getDeployRepoRow(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT deploy_repo_full_name, deploy_branch
     FROM project_railway_deployments
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return rows[0] || null;
}

/**
 * Token GitHub da installation da plataforma (repos deploy privados).
 */
export async function getPlatformGitHubToken() {
  const installationId = assertPlatformGitConfigured();
  const { token } = await getInstallationAccessToken(installationId);
  return { token, installationId: Number(installationId) };
}

/**
 * Garante repo deploy privado na org da plataforma.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function ensureDeployRepository(tenantId, projectSlug) {
  const installationId = assertPlatformGitConfigured();
  const gitRow = await getProjectGitRow(tenantId, projectSlug);
  const sourceBranch = gitRow?.github_tech_lead_branch || "tech-lead";
  const deployBranch = sourceBranch;

  const existing = await getDeployRepoRow(tenantId, projectSlug);
  if (existing?.deploy_repo_full_name) {
    if (existing.deploy_branch !== deployBranch) {
      await query(
        `UPDATE project_railway_deployments
         SET deploy_branch = $3, updated_at = now()
         WHERE tenant_id = $1 AND project_slug = $2`,
        [tenantId, projectSlug, deployBranch]
      );
    }
    return {
      repoFullName: existing.deploy_repo_full_name,
      deployBranch,
      sourceBranch,
      created: false,
    };
  }

  const repoName = buildDeployRepoName(tenantId, projectSlug);
  let fullName;
  let accountLogin = null;
  try {
    accountLogin = await resolveInstallationAccountLogin(Number(installationId));
  } catch {
    /* ignore */
  }

  try {
    const created = await createRepository(Number(installationId), {
      name: repoName,
      private: true,
      description: `DevForLess deploy (private) — ${projectSlug}`,
    });
    fullName = created.fullName;
  } catch (e) {
    if (e.status === 422) {
      const suffix = Date.now().toString(36).slice(-4);
      const retryName = `${repoName.slice(0, 90)}-${suffix}`;
      const created = await createRepository(Number(installationId), {
        name: retryName,
        private: true,
        description: `DevForLess deploy (private) — ${projectSlug}`,
      });
      fullName = created.fullName;
    } else {
      throw e;
    }
  }

  await query(
    `INSERT INTO project_railway_deployments (tenant_id, project_slug, deploy_repo_full_name, deploy_branch, status)
     VALUES ($1, $2, $3, $4, 'idle')
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       deploy_repo_full_name = COALESCE(project_railway_deployments.deploy_repo_full_name, EXCLUDED.deploy_repo_full_name),
       deploy_branch = COALESCE(project_railway_deployments.deploy_branch, EXCLUDED.deploy_branch),
       updated_at = now()`,
    [tenantId, projectSlug, fullName, deployBranch]
  );

  log.info("Repo deploy privado criado", {
    tenantId,
    project: projectSlug,
    repoFullName: fullName,
    accountLogin,
  });

  return {
    repoFullName: fullName,
    deployBranch,
    sourceBranch,
    created: true,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function buildRailwayProjectName(tenantId, projectSlug) {
  const prefix =
    String(process.env.RAILWAY_CLIENT_PROJECT_PREFIX || "df").trim() || "df";
  const tenantShort = String(tenantId).replace(/-/g, "").slice(0, 8).toLowerCase();
  const slug = String(projectSlug)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
  let name = `${prefix}-${tenantShort}-${slug}`;
  if (name.length > 100) name = name.slice(0, 100);
  return name;
}
