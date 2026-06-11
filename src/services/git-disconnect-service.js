import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { isClientGitRepoMode, isManagedGitRepoMode } from "../lib/project-git-public.js";
import { pauseContinuousExecution } from "./execution-dispatcher-service.js";
import {
  assertPlatformGitConfigured,
  ensureManagedGitRepository,
} from "./managed-git-service.js";
import {
  ensureGitProvisionJob,
  getLatestProvisionJob,
} from "./git-provision-service.js";
import { resolveInstallationAccountLogin } from "./github-app-service.js";

/**
 * @param {unknown} error
 */
function rethrowPlatformGitAuthError(error) {
  const e = /** @type {{ status?: number, code?: string, message?: string }} */ (
    error
  );
  if (e.status === 401 || e.code === "github_auth_exhausted") {
    throw Object.assign(
      new Error(
        "GitHub App da plataforma (repo managed): credenciais inválidas. " +
          "Confira GITHUB_APP_ID, github-app-private-key.pem (chave ativa) e " +
          "GITHUB_PLATFORM_INSTALLATION_ID. Isto não é o repositório Git do cliente."
      ),
      { status: 503, code: "platform_github_auth_failed" }
    );
  }
  throw error;
}

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function getGitDisconnectStatus(tenantId, slug) {
  const { rows } = await query(
    `SELECT github_repo_mode, git_status, git_last_error, github_managed_repo_full_name
     FROM projects WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug]
  );
  const row = rows[0];
  if (!row) {
    return { phase: "idle", gitStatus: null, repoMode: null };
  }

  const repoMode = row.github_repo_mode || null;
  const gitStatus = row.git_status || null;
  const job = await getLatestProvisionJob(tenantId, slug);

  /** @type {string} */
  let phase = "idle";
  /** @type {string|null} */
  let hint = null;

  if (gitStatus === "failed") {
    phase = "failed";
    hint = row.git_last_error || "O provisionamento falhou.";
  } else if (
    isManagedGitRepoMode(repoMode) &&
    ["pending", "provisioning", "migrating"].includes(String(gitStatus))
  ) {
    phase = "provisioning";
    if (job?.status === "queued") {
      hint =
        "Na fila — o worker CLI precisa estar ativo para reprovisionar o repo da plataforma.";
    } else if (job?.status === "running") {
      hint = "A sincronizar o código existente com o repositório managed…";
    } else if (!job) {
      hint = "A aguardar job de provisionamento…";
    }
  } else if (isManagedGitRepoMode(repoMode) && gitStatus === "ready") {
    phase = "ready";
    hint = "Git da plataforma ativo — repositório do cliente desligado.";
  } else if (isClientGitRepoMode(repoMode) && gitStatus === "ready") {
    phase = "client";
  }

  if (
    job?.status === "queued" &&
    job.created_at &&
    phase === "provisioning"
  ) {
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (ageMs > 3 * 60 * 1000) {
      hint =
        row.git_last_error ||
        "Job na fila há mais de 3 minutos. Verifique se o worker CLI está a correr.";
    }
  }

  if (job?.status === "failed" && phase !== "ready") {
    phase = "failed";
    hint =
      row.git_last_error ||
      (job.exit_code != null
        ? `Provision falhou (código ${job.exit_code})`
        : "Provision falhou");
  }

  return {
    phase,
    gitStatus,
    repoMode,
    lastError: row.git_last_error || null,
    managedRepoFullName: row.github_managed_repo_full_name || null,
    jobId: job?.id || null,
    jobStatus: job?.status || null,
    jobCreatedAt: job?.created_at || null,
    hint,
  };
}

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function startGitDisconnect(tenantId, slug) {
  const { rows } = await query(
    `SELECT slug, name, scope_md, github_repo_full_name, github_managed_repo_full_name,
            github_default_branch, github_tech_lead_branch, github_repo_mode, git_status
     FROM projects WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug]
  );
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }

  if (!isClientGitRepoMode(row.github_repo_mode)) {
    throw Object.assign(
      new Error("Este projeto não tem GitHub do cliente ligado."),
      { status: 409, code: "not_client_git" }
    );
  }

  if (row.git_status !== "ready") {
    throw Object.assign(
      new Error("Aguarde o workspace ficar pronto antes de desconectar."),
      { status: 409, code: "git_not_ready" }
    );
  }

  const platformInstallationId = assertPlatformGitConfigured();

  let managedRepoFullName = String(row.github_managed_repo_full_name || "").trim();
  let defaultBranch = row.github_default_branch || "main";
  let techLeadBranch = row.github_tech_lead_branch || "tech-lead";

  if (!managedRepoFullName) {
    const created = await ensureManagedGitRepository(tenantId, slug);
    managedRepoFullName = created.repoFullName;
    defaultBranch = created.defaultBranch;
    techLeadBranch = created.techLeadBranch;
  } else {
    let accountLogin = null;
    try {
      accountLogin = await resolveInstallationAccountLogin(platformInstallationId);
    } catch (e) {
      rethrowPlatformGitAuthError(e);
    }

    await query(
      `UPDATE projects SET
         github_managed_repo_full_name = COALESCE(github_managed_repo_full_name, $3),
         github_installation_id = $4,
         github_account_login = $5,
         github_connected_at = now(),
         github_repo_full_name = $6,
         github_default_branch = $7,
         github_tech_lead_branch = $8,
         github_repo_mode = 'managed',
         git_status = 'pending',
         git_last_error = NULL,
         updated_at = now()
       WHERE tenant_id = $1 AND slug = $2`,
      [
        tenantId,
        slug,
        managedRepoFullName,
        Number(platformInstallationId),
        accountLogin,
        managedRepoFullName,
        defaultBranch,
        techLeadBranch,
      ]
    );
  }

  await pauseContinuousExecution(tenantId, slug);

  const prov = await ensureGitProvisionJob(tenantId, slug, {
    resetGitCache: true,
  });

  if (!prov?.jobId) {
    throw Object.assign(
      new Error(
        "Não foi possível enfileirar o provisionamento. Tente novamente ou verifique o worker."
      ),
      { status: 503, code: "provision_enqueue_failed" }
    );
  }

  log.info("Git desconectado — provision managed enfileirado", {
    tenantId,
    project: slug,
    jobId: prov.jobId,
    managedRepoFullName,
  });

  return {
    jobId: prov.jobId,
    gitStatus: "provisioning",
    repoMode: "managed",
    managedRepoFullName,
    phase: "provisioning",
  };
}
