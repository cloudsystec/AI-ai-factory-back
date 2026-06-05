import { getPool } from "../db/pool.js";
import { getGitHubTokenForProject } from "./job-service.js";
import { getPullRequest } from "./github-app-service.js";
import { updateTaskPrTlReview } from "./task-pr-service.js";
import { dispatchQueuedWork } from "./execution-dispatcher-service.js";
import { getActiveExecutionForSlot } from "./execution-gate-service.js";
import { log } from "../lib/logger.js";

/**
 * @param {import("pg").PoolClient} client
 * @param {string} tenantId
 * @param {string[]} projectSlugs
 */
async function pickStuckPrRow(client, tenantId, projectSlugs) {
  if (!projectSlugs.length) return null;
  const { rows } = await client.query(
    `SELECT t.task_id, t.project_slug, t.pr_number, t.pr_url, t.head_branch, t.base_branch,
            t.tl_review_status, t.job_id,
            p.github_repo_full_name, p.github_tech_lead_branch, p.git_status,
            p.github_installation_id, p.github_repo_mode,
            tn.github_installation_id AS tenant_installation_id
     FROM task_pull_requests t
     INNER JOIN projects p
       ON p.tenant_id = t.tenant_id AND p.slug = t.project_slug
     INNER JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.tenant_id = $1
       AND t.project_slug = ANY($2::text[])
       AND t.merged_at IS NULL
       AND t.pr_number IS NOT NULL
       AND p.github_repo_full_name IS NOT NULL
       AND p.git_status = 'ready'
       AND p.github_repo_mode IN ('client', 'existing', 'created')
       AND COALESCE(p.github_installation_id, tn.github_installation_id) IS NOT NULL
       AND (
         t.tl_review_status IN ('pending', 'conflict')
         OR (
           t.tl_review_status = 'resolving'
           AND t.updated_at < now() - interval '15 minutes'
         )
       )
     ORDER BY
       CASE t.tl_review_status WHEN 'conflict' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       t.updated_at ASC
     LIMIT 1
     FOR UPDATE OF t SKIP LOCKED`,
    [tenantId, projectSlugs]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 */
export async function claimPrResolutionForWorker(tenantId, workerSlot) {
  const activeProjects = await getActiveExecutionForSlot(tenantId, workerSlot);
  const projectSlugs = activeProjects.map((p) => p.projectSlug);
  if (projectSlugs.length === 0) return null;

  for (let pass = 0; pass < 8; pass += 1) {
    const pool = getPool();
    const client = await pool.connect();
    let row;
    try {
      await client.query("BEGIN");
      row = await pickStuckPrRow(client, tenantId, projectSlugs);
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE task_pull_requests SET tl_review_status = 'resolving', updated_at = now()
         WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
        [tenantId, row.project_slug, row.task_id]
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const token = await getGitHubTokenForProject(tenantId, row.project_slug);
    const installationId =
      row.github_installation_id || row.tenant_installation_id;
    const [owner, repo] = String(row.github_repo_full_name).split("/");
    let skip = false;

    try {
      const ghPr = await getPullRequest(
        installationId,
        owner,
        repo,
        row.pr_number
      );
      if (ghPr.merged) {
        await finishPrResolution(tenantId, row.project_slug, row.task_id, {
          status: "merged",
          summary: `PR #${row.pr_number} já mergeado`,
        });
        skip = true;
      } else if (ghPr.state === "closed" && !ghPr.merged) {
        await finishPrResolution(tenantId, row.project_slug, row.task_id, {
          status: "failed",
          summary: `PR #${row.pr_number} fechado sem merge`,
        });
        skip = true;
      }
    } catch (e) {
      log.warn("pr-resolution: GitHub check falhou", { error: e.message });
    }

    if (skip) continue;

    return {
      projectSlug: row.project_slug,
      taskId: row.task_id,
      prNumber: row.pr_number,
      prUrl: row.pr_url,
      headBranch: row.head_branch,
      baseBranch: row.base_branch || row.github_tech_lead_branch || "tech-lead",
      techLeadBranch: row.github_tech_lead_branch || "tech-lead",
      repoFullName: row.github_repo_full_name,
      jobId: row.job_id,
      workerSlot,
      githubInstallationToken: token,
      tlReviewStatus: row.tl_review_status,
    };
  }
  return null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @param {{ status: string, summary?: string }} result
 */
export async function finishPrResolution(tenantId, projectSlug, taskId, result) {
  const status = result.status;
  const summary = result.summary || null;

  if (status === "merged") {
    await updateTaskPrTlReview(tenantId, projectSlug, taskId, {
      status: "merged",
      summary,
      mergedAt: new Date().toISOString(),
    });
  } else if (status === "conflict") {
    await updateTaskPrTlReview(tenantId, projectSlug, taskId, {
      status: "conflict",
      summary,
    });
  } else {
    await updateTaskPrTlReview(tenantId, projectSlug, taskId, {
      status: status === "failed" ? "failed" : "pending",
      summary,
    });
  }

  try {
    const dispatched = await dispatchQueuedWork(tenantId, projectSlug);
    return { dispatched };
  } catch (e) {
    log.warn("Dispatch após pr-resolution", { error: e.message });
    return { dispatched: { enqueued: [] } };
  }
}
