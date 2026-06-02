import { query } from "../db/pool.js";
import { getLatestJobForProject } from "./job-service.js";
import {
  readLiveScopeState,
  readLiveTaskDetail,
  readLiveTasks,
} from "./workspace-dashboard-reader.js";
import { getOpenMicroTasksDetail } from "./micro-wave-service.js";

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getTasksSnapshot(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT tasks_json FROM project_dashboard_snapshots
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  if (!rows[0]?.tasks_json) return [];
  const data = rows[0].tasks_json;
  return Array.isArray(data) ? data : [];
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getScopeStateSnapshot(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT scope_state_json FROM project_dashboard_snapshots
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return rows[0]?.scope_state_json ?? null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getDevelopSettings(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT autorun, skip_human_approval FROM project_develop_settings
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return {
    autorun: rows[0]?.autorun === true,
    skipHumanApproval: rows[0]?.skip_human_approval === true,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {boolean} autorun
 */
export async function setDevelopSettings(tenantId, projectSlug, settings) {
  const autorun =
    typeof settings === "boolean" ? settings : settings?.autorun === true;
  const skipHumanApproval =
    typeof settings === "object" && settings?.skipHumanApproval === true;
  await query(
    `INSERT INTO project_develop_settings (tenant_id, project_slug, autorun, skip_human_approval, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       autorun = EXCLUDED.autorun,
       skip_human_approval = EXCLUDED.skip_human_approval,
       updated_at = now()`,
    [tenantId, projectSlug, autorun, skipHumanApproval]
  );
  return getDevelopSettings(tenantId, projectSlug);
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
export async function getTaskDetailFromDb(tenantId, projectSlug, taskId) {
  const { rows } = await query(
    `SELECT detail_json FROM project_task_details
     WHERE tenant_id = $1 AND project_slug = $2 AND task_id = $3`,
    [tenantId, projectSlug, taskId]
  );
  return rows[0]?.detail_json ?? null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function buildDashboardMeta(tenantId, projectSlug, live) {
  const job = await getLatestJobForProject(tenantId, projectSlug);
  const activeStatuses = new Set(["running", "waiting_input", "queued"]);
  const activeJobId =
    job && activeStatuses.has(job.status) ? String(job.id) : null;
  return { live: live === true, activeJobId };
}

function cacheSnapshotAsync(tenantId, projectSlug, tasks, scopeState) {
  void upsertDashboardSnapshot(tenantId, projectSlug, tasks, scopeState).catch(
    () => {}
  );
}

function cacheTaskDetailAsync(tenantId, projectSlug, taskId, detail) {
  void upsertTaskDetail(tenantId, projectSlug, taskId, detail).catch(() => {});
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ source?: string }} [opts]
 */
export async function getTasksForDashboard(tenantId, projectSlug, opts = {}) {
  if (opts.source === "db") {
    const tasks = await getTasksSnapshot(tenantId, projectSlug);
    return { tasks, meta: await buildDashboardMeta(tenantId, projectSlug, false) };
  }

  const live = await readLiveTasks(tenantId, projectSlug);
  if (live.ok) {
    const meta = await buildDashboardMeta(tenantId, projectSlug, true);
    const scopeLive = await readLiveScopeState(tenantId, projectSlug);
    if (scopeLive.ok) {
      cacheSnapshotAsync(tenantId, projectSlug, live.tasks, scopeLive.scopeState);
    }
    return { tasks: live.tasks, meta };
  }

  const tasks = await getTasksSnapshot(tenantId, projectSlug);
  return { tasks, meta: await buildDashboardMeta(tenantId, projectSlug, false) };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {object|null} state
 */
function enrichScopeStateWithOpenMicroTasks(tenantId, projectSlug, state) {
  if (!state || typeof state !== "object" || !state.openMicro?.id) {
    return state;
  }
  try {
    const detail = getOpenMicroTasksDetail(
      tenantId,
      projectSlug,
      state.openMicro.id
    );
    return { ...state, openMicroTasksDetail: detail };
  } catch {
    return state;
  }
}

/**
 * @param {object} scopeState
 * @param {{ status?: string, completed_at?: Date|null }} projectRow
 */
function enrichScopeWithProjectStatus(scopeState, projectRow) {
  const completed = projectRow?.status === "completed";
  return {
    ...scopeState,
    projectCompleted: completed,
    projectStatus: projectRow?.status || "active",
    projectCompletedAt: projectRow?.completed_at || null,
  };
}

async function loadProjectRowForScope(tenantId, projectSlug) {
  const { getProjectStatus } = await import("./project-completion-service.js");
  return getProjectStatus(tenantId, projectSlug);
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ source?: string }} [opts]
 */
export async function getScopeStateForDashboard(tenantId, projectSlug, opts = {}) {
  let projectRow = await loadProjectRowForScope(tenantId, projectSlug);

  if (projectRow.status !== "completed") {
    try {
      const { tryCompleteProjectFromLiveState } = await import(
        "./project-completion-service.js"
      );
      const completion = await tryCompleteProjectFromLiveState(
        tenantId,
        projectSlug
      );
      if (completion.completed) {
        projectRow = await loadProjectRowForScope(tenantId, projectSlug);
      }
    } catch (e) {
      const { log } = await import("../lib/logger.js");
      log.warn("Auto-finalização ao carregar scope", {
        project: projectSlug,
        error: e.message,
      });
    }
  }

  if (opts.source === "db") {
    const state = await getScopeStateSnapshot(tenantId, projectSlug);
    const meta = await buildDashboardMeta(tenantId, projectSlug, false);
    return state
      ? enrichScopeWithProjectStatus(
          enrichScopeStateWithOpenMicroTasks(tenantId, projectSlug, {
            ...state,
            dashboardMeta: meta,
          }),
          projectRow
        )
      : null;
  }

  const live = await readLiveScopeState(tenantId, projectSlug);
  if (live.ok && live.scopeState) {
    const meta = await buildDashboardMeta(tenantId, projectSlug, true);
    const tasksLive = await readLiveTasks(tenantId, projectSlug);
    if (tasksLive.ok) {
      cacheSnapshotAsync(
        tenantId,
        projectSlug,
        tasksLive.tasks,
        live.scopeState
      );
    }
    return enrichScopeWithProjectStatus(
      enrichScopeStateWithOpenMicroTasks(tenantId, projectSlug, {
        ...live.scopeState,
        dashboardMeta: meta,
      }),
      projectRow
    );
  }

  const state = await getScopeStateSnapshot(tenantId, projectSlug);
  const meta = await buildDashboardMeta(tenantId, projectSlug, false);
  return state
    ? enrichScopeWithProjectStatus(
        enrichScopeStateWithOpenMicroTasks(tenantId, projectSlug, {
          ...state,
          dashboardMeta: meta,
        }),
        projectRow
      )
    : null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
export async function getTaskDetail(tenantId, projectSlug, taskId) {
  const live = await readLiveTaskDetail(tenantId, projectSlug, taskId);
  if (live.ok && live.detail) {
    cacheTaskDetailAsync(tenantId, projectSlug, taskId, live.detail);
    return live.detail;
  }

  const fromDb = await getTaskDetailFromDb(tenantId, projectSlug, taskId);
  if (fromDb) return fromDb;

  if (live.ok && live.detail === null) return null;
  return null;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {unknown} tasks
 * @param {unknown} scopeState
 */
export async function upsertDashboardSnapshot(tenantId, projectSlug, tasks, scopeState) {
  await query(
    `INSERT INTO project_dashboard_snapshots
       (tenant_id, project_slug, tasks_json, scope_state_json, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       tasks_json = EXCLUDED.tasks_json,
       scope_state_json = EXCLUDED.scope_state_json,
       updated_at = now()`,
    [
      tenantId,
      projectSlug,
      JSON.stringify(tasks ?? []),
      scopeState == null ? null : JSON.stringify(scopeState),
    ]
  );

  const microCount = Number(scopeState?.microCount) || 0;
  if (microCount > 0) {
    const taskList = Array.isArray(tasks) ? tasks : [];
    const { computeAndStorePlannedCost } = await import("./project-billing-service.js");
    await computeAndStorePlannedCost(tenantId, projectSlug, {
      microCount,
      taskCount: taskList.length,
    });
  }

  try {
    const { maybeCompleteProjectFromSnapshot } = await import(
      "./project-completion-service.js"
    );
    await maybeCompleteProjectFromSnapshot(
      tenantId,
      projectSlug,
      scopeState,
      Array.isArray(tasks) ? tasks : []
    );
  } catch (e) {
    const { log } = await import("../lib/logger.js");
    log.warn("Detecção finalização projecto", {
      project: projectSlug,
      error: e.message,
    });
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @param {unknown} detail
 */
/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function clearProjectDashboard(tenantId, projectSlug) {
  await query(
    `DELETE FROM project_task_details
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  await query(
    `DELETE FROM project_dashboard_snapshots
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
}

export async function upsertTaskDetail(tenantId, projectSlug, taskId, detail) {
  await query(
    `INSERT INTO project_task_details
       (tenant_id, project_slug, task_id, detail_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (tenant_id, project_slug, task_id) DO UPDATE SET
       detail_json = EXCLUDED.detail_json,
       updated_at = now()`,
    [tenantId, projectSlug, taskId, JSON.stringify(detail)]
  );
}
