import { query } from "../db/pool.js";
import { pauseContinuousExecution } from "./execution-dispatcher-service.js";
import { log } from "../lib/logger.js";
import {
  readBacklogTasks,
  getMicroWaveState,
  isTaskDone,
} from "./micro-wave-service.js";
import { readTasksState } from "./task-state-service.js";

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getProjectStatus(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT status, completed_at FROM projects WHERE tenant_id = $1 AND slug = $2`,
    [tenantId, projectSlug]
  );
  return rows[0] || { status: "active", completed_at: null };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function assertProjectNotCompleted(tenantId, projectSlug) {
  const row = await getProjectStatus(tenantId, projectSlug);
  if (row.status === "completed") {
    throw Object.assign(new Error("Projeto finalizado — execução desactivada."), {
      status: 403,
      code: "project_completed",
    });
  }
}

/**
 * Critério alinhado com scope-dashboard-state + micro-wave (backlog + runtime).
 * @param {unknown} scopeState
 * @param {object[]} backlogTasks
 * @param {object[]} tasksState
 * @param {string|null|undefined} waveOpenMicroId
 */
export function assessProjectCompletion(
  scopeState,
  backlogTasks,
  tasksState,
  waveOpenMicroId
) {
  if (scopeState?.projectCompleted) return true;
  if (scopeState?.allTasksSuccessful && scopeState?.wavesCompleteScenario) {
    return true;
  }

  if (
    Array.isArray(tasksState) &&
    tasksState.some((t) => t.status === "blocked" || t.blockReason)
  ) {
    return false;
  }

  const microCount = Number(scopeState?.microCount) || 0;
  const microPoDone =
    microCount > 0 &&
    (Number(scopeState?.microsPendingPo) || 0) === 0 &&
    (Number(scopeState?.microsApproved) || 0) > 0;

  const stateById = new Map(
    (Array.isArray(tasksState) ? tasksState : []).map((t) => [t.id, t])
  );
  const delivered = (Array.isArray(backlogTasks) ? backlogTasks : []).filter(
    (t) => t.sourceMicroId
  );

  const allDeliveredDone =
    delivered.length === 0 ||
    delivered.every((t) => isTaskDone(t, stateById));

  if (!allDeliveredDone) return false;

  // Ondas fechadas no CLI — fonte de verdade mesmo se wavePhase no ficheiro estiver stale
  if (scopeState?.wavesCompleteScenario && microPoDone) {
    return true;
  }

  if (waveOpenMicroId) return false;

  // Todas as entregas concluídas e sem micro aberto no dispatch — finaliza mesmo se openMicro no scope estiver stale (backlog desincronizado).
  if (allDeliveredDone && microPoDone) {
    return true;
  }

  if (scopeState?.openMicro) return false;

  if (delivered.length === 0) {
    return microPoDone;
  }

  return microPoDone;
}

/**
 * Valida se todas as tasks/micros estão concluídas com sucesso.
 * @param {unknown} scopeState
 * @param {unknown[]} tasks
 * @param {{ backlogTasks?: object[], tasksState?: object[], waveOpenMicroId?: string|null }} [opts]
 */
export function isProjectFullyComplete(scopeState, tasks, opts = {}) {
  if (opts.backlogTasks && opts.tasksState) {
    return assessProjectCompletion(
      scopeState,
      opts.backlogTasks,
      opts.tasksState,
      opts.waveOpenMicroId
    );
  }

  if (scopeState?.allTasksSuccessful && scopeState?.wavesCompleteScenario) {
    return true;
  }

  if (!scopeState?.wavesCompleteScenario) return false;

  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return false;

  return list.every((t) => {
    if (!t || typeof t !== "object") return false;
    if (t.status === "blocked" || t.blockReason) return false;
    if (t.currentAgent === "Human Approval Pending") return false;
    return t.status === "done";
  });
}

/**
 * Marca projecto como concluído e para execução contínua.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function markProjectCompleted(tenantId, projectSlug) {
  const current = await getProjectStatus(tenantId, projectSlug);
  if (current.status === "completed") {
    return { alreadyCompleted: true, completedAt: current.completed_at };
  }

  await query(
    `UPDATE projects SET status = 'completed', completed_at = now()
     WHERE tenant_id = $1 AND slug = $2 AND status <> 'completed'`,
    [tenantId, projectSlug]
  );

  try {
    await pauseContinuousExecution(tenantId, projectSlug);
  } catch (e) {
    log.warn("Pause após finalização", { project: projectSlug, error: e.message });
  }

  log.info("Projeto finalizado", { tenantId, project: projectSlug });

  try {
    const { broadcast } = await import("../lib/ws-hub.js");
    broadcast(tenantId, { type: "dashboard", project: projectSlug });
    broadcast(tenantId, { type: "execution", project: projectSlug });
  } catch {
    /* ignore */
  }

  const after = await getProjectStatus(tenantId, projectSlug);
  return { alreadyCompleted: false, completedAt: after.completed_at };
}

/**
 * Detecta conclusão a partir do snapshot e persiste se necessário.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {unknown} scopeState
 * @param {unknown[]} tasks
 */
export async function maybeCompleteProjectFromSnapshot(
  tenantId,
  projectSlug,
  scopeState,
  tasks
) {
  const current = await getProjectStatus(tenantId, projectSlug);
  if (current.status === "completed") return null;

  const backlog = readBacklogTasks(tenantId, projectSlug);
  const tasksState = readTasksState(tenantId, projectSlug);
  const wave = await getMicroWaveState(tenantId, projectSlug);

  if (
    !isProjectFullyComplete(scopeState, tasks, {
      backlogTasks: backlog,
      tasksState,
      waveOpenMicroId: wave.openMicroId,
    })
  ) {
    return null;
  }
  return markProjectCompleted(tenantId, projectSlug);
}

/**
 * Lê estado live (ou snapshot) e finaliza o projecto se tudo estiver concluído.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function tryCompleteProjectFromLiveState(tenantId, projectSlug) {
  const current = await getProjectStatus(tenantId, projectSlug);
  if (current.status === "completed") {
    return {
      completed: true,
      alreadyCompleted: true,
      completedAt: current.completed_at,
    };
  }

  const { readLiveScopeState, readLiveTasks } = await import(
    "./workspace-dashboard-reader.js"
  );
  const { getScopeStateSnapshot, getTasksSnapshot } = await import(
    "./project-dashboard-service.js"
  );

  let scopeState = null;
  const scopeLive = await readLiveScopeState(tenantId, projectSlug);
  if (scopeLive.ok && scopeLive.scopeState) {
    scopeState = scopeLive.scopeState;
  } else {
    scopeState = await getScopeStateSnapshot(tenantId, projectSlug);
  }

  let tasks = [];
  const tasksLive = await readLiveTasks(tenantId, projectSlug);
  if (tasksLive.ok && Array.isArray(tasksLive.tasks)) {
    tasks = tasksLive.tasks;
  } else {
    tasks = await getTasksSnapshot(tenantId, projectSlug);
  }

  const backlog = readBacklogTasks(tenantId, projectSlug);
  const tasksState = readTasksState(tenantId, projectSlug);
  const wave = await getMicroWaveState(tenantId, projectSlug);

  const complete = isProjectFullyComplete(scopeState, tasks, {
    backlogTasks: backlog,
    tasksState,
    waveOpenMicroId: wave.openMicroId,
  });

  if (!complete) {
    log.debug("Projecto ainda não elegível para finalização", {
      project: projectSlug,
      wavesCompleteScenario: scopeState?.wavesCompleteScenario ?? false,
      allTasksSuccessful: scopeState?.allTasksSuccessful ?? false,
      waveOpenMicroId: wave.openMicroId,
      backlogTasks: backlog.length,
      blockedRuntime: tasksState.filter((t) => t.status === "blocked").length,
    });
    return { completed: false };
  }

  const marked = await markProjectCompleted(tenantId, projectSlug);
  return { completed: true, ...marked };
}
