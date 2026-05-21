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
 */
export async function resetProjectPlanning(tenantId, slug) {
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
    throw Object.assign(
      new Error(
        "Há um job em execução neste projeto. Interrompa ou aguarde antes do reset."
      ),
      { status: 409, code: "JOB_ACTIVE" }
    );
  }

  const { name, scopeMd } = await resolveProjectScopeMd(tenantId, project);
  const meta = { name, scopeMd };

  const backup = backupProjectToZip(tenantId, slug, meta);

  resetProjectPlanningOnDisk(tenantId, slug, meta);

  await resetProjectAgentsFromTemplates(tenantId, slug);
  await writeProjectAgentsToDisk(tenantId, slug);

  await clearProjectDashboard(tenantId, slug);
  await upsertDashboardSnapshot(tenantId, slug, [], emptyScopeState(slug));

  return {
    project: slug,
    macroId: slug,
    backup,
    message: backup.hadContent
      ? `Backup em ${backup.backupRelative}. Workspace e planeamento repostos a zero.`
      : `Nada para arquivar; workspace e planeamento criados a partir do escopo na BD.`,
  };
}
