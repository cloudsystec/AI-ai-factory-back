import {
  pauseContinuousExecution,
  startAllReadyWorkers,
  startWorkerSlot,
  stopWorkerSlot,
  getExecutionState,
} from "./execution-dispatcher-service.js";
import {
  getProjectBillingSummary,
  sumActualCostForProjectToday,
} from "./project-billing-service.js";
import {
  getDevelopSettings,
  setDevelopSettings,
  getScopeStateSnapshot,
  getTasksSnapshot,
} from "./project-dashboard-service.js";
import { getProjectMacroScope, updateProjectMacroScope } from "./macro-scope-service.js";
import { resetProjectPlanning } from "./project-reset-service.js";
import {
  getEditabilityReport,
  updateMicroAndRegenerateTasks,
  updateTaskFields,
} from "./project-scope-edit-service.js";

const READ_TOOLS = new Set([
  "get_execution_state",
  "get_project_cost",
  "get_project_cost_today",
  "get_scope_state",
  "get_tasks_summary",
  "get_macro_scope",
  "get_editability_report",
]);

const WRITE_IMMEDIATE = new Set([
  "update_task",
  "pause_all_bots",
  "play_all_bots",
  "stop_worker_slot",
  "start_worker_slot",
  "update_develop_settings",
]);

const WRITE_CONFIRM = new Set([
  "improve_macro_scope",
  "update_micro_scope",
  "reset_project",
]);

/**
 * @param {object} caps
 * @param {string} toolName
 */
function requiredCapability(toolName) {
  if (READ_TOOLS.has(toolName)) return null;
  if (
    [
      "pause_all_bots",
      "play_all_bots",
      "stop_worker_slot",
      "start_worker_slot",
    ].includes(toolName)
  ) {
    return "execute";
  }
  return "write";
}

/**
 * @param {object} ctx
 * @param {string} toolName
 * @param {object} args
 */
export async function executeCopilotTool(ctx, toolName, args = {}) {
  const name = String(toolName ?? "").trim();
  if (!name) {
    throw Object.assign(new Error("Tool inválida"), { status: 400 });
  }

  const all = new Set([...READ_TOOLS, ...WRITE_IMMEDIATE, ...WRITE_CONFIRM]);
  if (!all.has(name)) {
    throw Object.assign(new Error(`Tool desconhecida: ${name}`), { status: 400 });
  }

  const cap = requiredCapability(name);
  if (cap === "execute" && !ctx.capabilities?.canExecute) {
    throw Object.assign(new Error("Sem permissão de execução."), { status: 403 });
  }
  if (cap === "write" && !ctx.capabilities?.canWrite) {
    throw Object.assign(new Error("Sem permissão de escrita."), { status: 403 });
  }

  const { tenantId, projectSlug, userId } = ctx;

  switch (name) {
    case "get_execution_state": {
      const state = await getExecutionState(tenantId, projectSlug);
      return {
        continuousActive: state.continuous_active,
        pauseAfterCurrent: state.pause_after_current,
        selectedWorkerSlots: state.selected_worker_slots || [],
      };
    }
    case "get_project_cost":
      return (await getProjectBillingSummary(tenantId, projectSlug)) || {};
    case "get_project_cost_today":
      return {
        projectSlug,
        actualCostUsdToday: await sumActualCostForProjectToday(
          tenantId,
          projectSlug
        ),
      };
    case "get_scope_state":
      return (await getScopeStateSnapshot(tenantId, projectSlug)) || {};
    case "get_tasks_summary": {
      const tasks = await getTasksSnapshot(tenantId, projectSlug);
      return {
        total: tasks.length,
        byColumn: tasks.reduce((acc, t) => {
          const key = t.column || t.status || "unknown";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
        tasks: tasks.slice(0, 30).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          microId: t.microId || t.sourceMicroId,
        })),
      };
    }
    case "get_macro_scope":
      return getProjectMacroScope(tenantId, projectSlug);
    case "get_editability_report":
      return getEditabilityReport(tenantId, projectSlug);
    case "update_task":
      return updateTaskFields(
        tenantId,
        projectSlug,
        String(args.taskId ?? ""),
        args.patch || {}
      );
    case "pause_all_bots":
      return pauseContinuousExecution(tenantId, projectSlug);
    case "play_all_bots":
      return startAllReadyWorkers(tenantId, projectSlug, {
        executorUserId: userId,
      });
    case "stop_worker_slot":
      return stopWorkerSlot(
        tenantId,
        projectSlug,
        Number(args.slot ?? args.workerSlot ?? 1)
      );
    case "start_worker_slot":
      return startWorkerSlot(tenantId, projectSlug, Number(args.slot ?? 1), {
        executorUserId: userId,
      });
    case "update_develop_settings": {
      const current = await getDevelopSettings(tenantId, projectSlug);
      const next = {
        autorun:
          args.autorun !== undefined ? args.autorun === true : current.autorun,
        skipHumanApproval:
          args.skipHumanApproval !== undefined
            ? args.skipHumanApproval === true
            : current.skipHumanApproval,
      };
      return setDevelopSettings(tenantId, projectSlug, next);
    }
    default:
      throw Object.assign(new Error(`Tool não implementada: ${name}`), {
        status: 501,
      });
  }
}

/**
 * @param {object} ctx
 * @param {string} actionType
 * @param {object} payload
 */
export async function executeConfirmedAction(ctx, actionType, payload) {
  const { tenantId, projectSlug, userId } = ctx;
  switch (actionType) {
    case "improve_macro_scope": {
      const scopeMd = String(payload.scopeMd ?? "").trim();
      if (!scopeMd) {
        throw Object.assign(new Error("scopeMd obrigatório"), { status: 400 });
      }
      return updateProjectMacroScope(tenantId, projectSlug, scopeMd);
    }
    case "update_micro_scope":
      return updateMicroAndRegenerateTasks(
        tenantId,
        projectSlug,
        String(payload.microId ?? ""),
        payload.patch || {},
        String(payload.instructions ?? ""),
        userId
      );
    case "reset_project":
      return resetProjectPlanning(tenantId, projectSlug, {
        forceStop: payload.forceStop === true,
      });
    default:
      throw Object.assign(new Error(`Ação desconhecida: ${actionType}`), {
        status: 400,
      });
  }
}

export { READ_TOOLS, WRITE_IMMEDIATE, WRITE_CONFIRM };
