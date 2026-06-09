/** Modos em que o cliente ligou o GitHub (UI Git/PR visível). */
const CLIENT_REPO_MODES = new Set(["client", "existing", "created"]);

/**
 * @param {string|null|undefined} repoMode
 */
export function isClientGitRepoMode(repoMode) {
  return CLIENT_REPO_MODES.has(String(repoMode || ""));
}

/**
 * @param {string|null|undefined} repoMode
 */
export function isManagedGitRepoMode(repoMode) {
  return String(repoMode || "") === "managed";
}

/**
 * Azul escuro: sem micros (escopo macro ainda editável).
 * Amarelo: já tem micros, pipeline em curso.
 * Verde: projecto finalizado.
 *
 * @param {string|null|undefined} projectStatus
 * @param {unknown} scopeStateJson
 * @returns {'not_started'|'started'|'completed'}
 */
export function deriveProjectLifecycleStatus(projectStatus, scopeStateJson) {
  if (projectStatus === "completed") return "completed";

  const scope =
    scopeStateJson && typeof scopeStateJson === "object" ? scopeStateJson : null;
  if (scope?.projectCompleted) return "completed";

  if (!scope || (scope.microCount ?? 0) === 0) {
    return "not_started";
  }

  return "started";
}

/**
 * Resposta pública do projecto — oculta campos Git em modo managed.
 * @param {Record<string, unknown>} row
 */
export function toPublicProjectGit(row) {
  if (!row) return null;
  const repoMode = row.github_repo_mode || null;
  const status = row.status || "active";
  const base = {
    slug: row.slug,
    name: row.name,
    scopeMd: row.scope_md,
    repoMode,
    gitStatus: row.git_status,
    gitLastError: row.git_last_error,
    status,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    lifecycleStatus: deriveProjectLifecycleStatus(status, row.scope_state_json),
  };

  if (isManagedGitRepoMode(repoMode)) {
    return {
      ...base,
      gitStatus: row.git_status === "ready" ? "ready" : row.git_status,
      defaultBranch: null,
      techLeadBranch: null,
      repoFullName: null,
    };
  }

  if (row.git_status === "not_connected") {
    return {
      ...base,
      defaultBranch: null,
      techLeadBranch: null,
      repoFullName: null,
    };
  }

  return {
    ...base,
    defaultBranch: row.github_default_branch,
    techLeadBranch: row.github_tech_lead_branch,
    repoFullName: row.github_repo_full_name,
  };
}
