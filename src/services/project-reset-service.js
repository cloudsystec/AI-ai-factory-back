import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool.js";
import { emptyScopeState } from "../lib/empty-scope-state.js";
import { backupProjectToZip } from "../lib/project-backup.js";
import { resolveProjectScopeMd } from "../lib/resolve-project-scope.js";
import { writeProjectAgentsToDisk } from "../lib/write-project-agents-disk.js";
import { resetProjectAgentsFromTemplates } from "./agent-config-service.js";
import {
  tenantMacroDir,
  tenantWorkspacesDir,
} from "../lib/tenant-paths.js";
import {
  clearProjectDashboard,
  upsertDashboardSnapshot,
} from "./project-dashboard-service.js";
import { releaseWorkLocksForJob } from "./work-lock-service.js";
import { broadcast } from "../lib/ws-hub.js";

/**
 * Pausa execução, cancela jobs activos/na fila e liberta locks do projecto.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function forceStopProjectExecution(tenantId, projectSlug) {
  await query(
    `INSERT INTO tenant_execution (tenant_id, project_slug, continuous_active, pause_after_current,
       selected_worker_slots, updated_at)
     VALUES ($1, $2, false, true, '[]'::jsonb, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       continuous_active = false,
       pause_after_current = true,
       selected_worker_slots = '[]'::jsonb,
       updated_at = now()`,
    [tenantId, projectSlug]
  );

  const { rows: activeJobs } = await query(
    `SELECT id FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2
       AND status IN ('queued', 'running', 'waiting_input')`,
    [tenantId, projectSlug]
  );

  for (const row of activeJobs) {
    await releaseWorkLocksForJob(row.id);
    await query(
      `UPDATE jobs
       SET status = 'cancelled',
           finished_at = COALESCE(finished_at, now()),
           exit_code = COALESCE(exit_code, 130)
       WHERE id = $1 AND tenant_id = $2`,
      [row.id, tenantId]
    );
  }

  await query(
    `DELETE FROM work_locks WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );

  try {
    const { reconcileTenantSlotsInUse } = await import(
      "./execution-dispatcher-service.js"
    );
    await reconcileTenantSlotsInUse(tenantId);
  } catch {
    /* ignore */
  }

  broadcast(tenantId, {
    type: "execution",
    project: projectSlug,
    continuousActive: false,
    pauseAfterCurrent: true,
    selectedWorkerSlots: [],
  });
  broadcast(tenantId, { type: "dashboard", project: projectSlug, reason: "force-stop" });
  broadcast(tenantId, { type: "billing" });

  return { cancelledJobIds: activeJobs.map((r) => r.id) };
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {{ name: string, scopeMd: string }} meta
 */
export function resetProjectPlanningOnDisk(tenantId, slug, meta) {
  const macroPath = path.join(tenantMacroDir(tenantId), `${slug}.md`);
  const wsRoot = path.join(tenantWorkspacesDir(tenantId), slug);

  if (fs.existsSync(wsRoot)) {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }

  const macroBody = `# ${meta.name}\n\n${meta.scopeMd.trim()}\n`;
  fs.mkdirSync(path.dirname(macroPath), { recursive: true });
  fs.writeFileSync(macroPath, macroBody, "utf-8");

  fs.mkdirSync(wsRoot, { recursive: true });
  fs.mkdirSync(path.join(wsRoot, "scopes", "micro"), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, "backlog"), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, "reports", "scopes"), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, "docs", "scopes"), { recursive: true });

  const backlogPath = path.join(wsRoot, "backlog", `${slug}.tasks.json`);
  fs.writeFileSync(
    backlogPath,
    `${JSON.stringify(
      {
        project: slug,
        macroId: slug,
        tasks: [],
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  fs.writeFileSync(path.join(wsRoot, "tasks-state.json"), "[]\n", "utf-8");
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {{ forceStop?: boolean }} [opts]
 */
export async function resetProjectPlanning(tenantId, slug, opts = {}) {
  const { rows } = await query(
    "SELECT slug, name, scope_md FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, slug]
  );
  const project = rows[0];
  if (!project) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
  const { rows: activeJobs } = await query(
    `SELECT id FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2
       AND status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, slug]
  );
  if (activeJobs[0]) {
    if (!opts.forceStop) {
      throw Object.assign(
        new Error(
          "Há um job em execução neste projeto. Interrompa ou aguarde antes do reset."
        ),
        { status: 409, code: "JOB_ACTIVE" }
      );
    }
    await forceStopProjectExecution(tenantId, slug);
  }

  const { name, scopeMd } = await resolveProjectScopeMd(tenantId, project);
  const meta = { name, scopeMd };

  const backup = backupProjectToZip(tenantId, slug, meta);

  resetProjectPlanningOnDisk(tenantId, slug, meta);

  await resetProjectAgentsFromTemplates(tenantId, slug);
  await writeProjectAgentsToDisk(tenantId, slug);

  await clearProjectDashboard(tenantId, slug);
  await upsertDashboardSnapshot(tenantId, slug, [], emptyScopeState(slug));

  await query(
    `UPDATE projects SET git_status = 'pending', git_last_error = NULL WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, slug]
  );

  await query(
    `DELETE FROM task_pull_requests WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, slug]
  );

  await query(
    `DELETE FROM tenant_execution WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, slug]
  );

  return {
    project: slug,
    macroId: slug,
    backup,
    message: backup.hadContent
      ? `Backup em ${backup.backupRelative}. Workspace e planeamento repostos a zero.`
      : `Nada para arquivar; workspace e planeamento criados a partir do escopo na BD.`,
  };
}
