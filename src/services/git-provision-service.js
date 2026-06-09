import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { getProjectGitRow } from "./project-git-service.js";

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function hasProvisionJobActive(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT 1 FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'provision'
       AND status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  return rows.length > 0;
}

/**
 * Enfileira job provision se o projecto tem Git pendente e ainda não há job activo.
 * Não exige Play nos workers nem execução contínua.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ resetGitCache?: boolean }} [opts]
 * @returns {Promise<{ jobId: string }|null>}
 */
export async function ensureGitProvisionJob(tenantId, projectSlug, opts = {}) {
  const gitRow = await getProjectGitRow(tenantId, projectSlug);
  if (!gitRow) return null;

  const status = gitRow.git_status;
  if (status === "ready" || status === "not_connected" || !status) {
    return null;
  }

  if (await hasProvisionJobActive(tenantId, projectSlug)) {
    const active = await getLatestProvisionJob(tenantId, projectSlug);
    return active?.id ? { jobId: active.id } : null;
  }

  if (!gitRow.github_repo_full_name) {
    return null;
  }

  const id = randomUUID();
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, status, payload)
     VALUES ($1, $2, $3, 'provision', 'queued', $4::jsonb)`,
    [
      id,
      tenantId,
      projectSlug,
      JSON.stringify({
        name: gitRow.name || projectSlug,
        slug: projectSlug,
        scope: gitRow.scope_md || "",
        git: {
          repoMode: gitRow.github_repo_mode || "existing",
          repoFullName: gitRow.github_repo_full_name,
          defaultBranch: gitRow.github_default_branch || "main",
          techLeadBranch: gitRow.github_tech_lead_branch || "tech-lead",
          resetGitCache: opts.resetGitCache === true,
        },
      }),
    ]
  );

  if (status === "pending" || status === "migrating") {
    await query(
      `UPDATE projects SET git_status = 'provisioning', updated_at = now()
       WHERE tenant_id = $1 AND slug = $2 AND git_status IN ('pending', 'migrating')`,
      [tenantId, projectSlug]
    );
  }

  log.info("Provision Git enfileirado (sem Play)", {
    project: projectSlug,
    jobId: id,
    resetGitCache: opts.resetGitCache === true,
  });
  return { jobId: id };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function getLatestProvisionJob(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT id, status, created_at, started_at, finished_at, exit_code
     FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'provision'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  return rows[0] || null;
}

export { getLatestProvisionJob };

/**
 * @param {string} tenantId
 */
export async function ensureAllPendingGitProvisions(tenantId) {
  const { rows } = await query(
    `SELECT slug FROM projects
     WHERE tenant_id = $1
       AND git_status IN ('pending', 'provisioning', 'migrating')
       AND github_repo_full_name IS NOT NULL`,
    [tenantId]
  );
  /** @type {string[]} */
  const enqueued = [];
  for (const row of rows) {
    const r = await ensureGitProvisionJob(tenantId, row.slug);
    if (r?.jobId) enqueued.push(r.jobId);
  }
  return { enqueued };
}
