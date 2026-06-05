import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import {
  createRepository,
  isGitHubAppConfigured,
  resolveInstallationAccountLogin,
} from "./github-app-service.js";

const DEFAULT_PREFIX = "df";
const DEFAULT_BRANCH = "main";
const TECH_LEAD_BRANCH = "tech-lead";

export function getPlatformInstallationId() {
  const raw = String(process.env.GITHUB_PLATFORM_INSTALLATION_ID || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getManagedRepoPrefix() {
  return String(process.env.GITHUB_MANAGED_REPO_PREFIX || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
}

export function assertPlatformGitConfigured() {
  if (!isGitHubAppConfigured()) {
    throw Object.assign(
      new Error("GitHub App não configurada no servidor."),
      { status: 503, code: "github_not_configured" }
    );
  }
  const installationId = getPlatformInstallationId();
  if (!installationId) {
    throw Object.assign(
      new Error("GITHUB_PLATFORM_INSTALLATION_ID não configurado."),
      { status: 503, code: "platform_git_not_configured" }
    );
  }
  return installationId;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function buildManagedRepoName(tenantId, projectSlug) {
  const prefix = getManagedRepoPrefix();
  const tenantShort = String(tenantId).replace(/-/g, "").slice(0, 8).toLowerCase();
  const slug = String(projectSlug).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  let name = `${prefix}-${tenantShort}-${slug}`;
  if (name.length > 100) {
    name = name.slice(0, 100);
  }
  return name;
}

/**
 * Cria repo privado na org da plataforma e actualiza o projecto.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function ensureManagedGitRepository(tenantId, projectSlug) {
  const installationId = assertPlatformGitConfigured();
  const repoName = buildManagedRepoName(tenantId, projectSlug);

  let fullName;
  let accountLogin = null;
  try {
    accountLogin = await resolveInstallationAccountLogin(installationId);
  } catch {
    /* ignore */
  }

  try {
    const created = await createRepository(installationId, {
      name: repoName,
      private: true,
      description: `AI Factory managed — ${projectSlug}`,
    });
    fullName = created.fullName;
  } catch (e) {
    if (e.status === 422) {
      const suffix = Date.now().toString(36).slice(-4);
      const retryName = `${repoName.slice(0, 90)}-${suffix}`;
      const created = await createRepository(installationId, {
        name: retryName,
        private: true,
        description: `AI Factory managed — ${projectSlug}`,
      });
      fullName = created.fullName;
    } else {
      throw e;
    }
  }

  await query(
    `UPDATE projects SET
       github_installation_id = $3,
       github_account_login = $4,
       github_connected_at = now(),
       github_repo_full_name = $5,
       github_default_branch = $6,
       github_tech_lead_branch = $7,
       github_repo_mode = 'managed',
       git_status = 'pending',
       git_last_error = NULL,
       updated_at = now()
     WHERE tenant_id = $1 AND slug = $2`,
    [
      tenantId,
      projectSlug,
      Number(installationId),
      accountLogin,
      fullName,
      DEFAULT_BRANCH,
      TECH_LEAD_BRANCH,
    ]
  );

  log.info("Repo managed criado", {
    tenantId,
    project: projectSlug,
    repoFullName: fullName,
  });

  return {
    installationId: Number(installationId),
    repoFullName: fullName,
    defaultBranch: DEFAULT_BRANCH,
    techLeadBranch: TECH_LEAD_BRANCH,
    repoMode: "managed",
  };
}
