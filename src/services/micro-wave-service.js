import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool.js";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import { allMicroTaskPrsMerged } from "./task-pr-service.js";
import { readTasksState } from "./task-state-service.js";

/**
 * Lê micros do volume (simplificado para gates API).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function readMicrosFromVolume(tenantId, projectSlug) {
  const microPath = path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "scopes",
    "micro",
    `${projectSlug}.micro.json`
  );
  if (!fs.existsSync(microPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(microPath, "utf-8"));
    if (Array.isArray(raw)) return raw;
    for (const key of ["microscopes", "microScopes", "items"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function readBacklogTasks(tenantId, projectSlug) {
  const bp = path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "backlog",
    `${projectSlug}.tasks.json`
  );
  if (!fs.existsSync(bp)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(bp, "utf-8"));
    return doc.tasks || [];
  } catch {
    return [];
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
const TERMINAL_RUNTIME = new Set([
  "done",
  "blocked",
  "running",
  "review",
  "testing",
  "development",
  "planning",
]);

/**
 * @param {object[]} microTasks
 * @param {object[]} backlog
 * @param {Map<string, object>} stateByTaskId
 */
export function taskDependenciesMet(task, backlog, stateByTaskId) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  if (deps.length === 0) return true;
  return deps.every((depId) => {
    const rt = stateByTaskId?.get(depId);
    if (rt?.status === "done") return true;
    const dep = backlog.find((t) => t.id === depId);
    return dep?.status === "done";
  });
}

/**
 * @param {object} task
 * @param {Map<string, object>} stateByTaskId
 */
export function isTaskDone(task, stateByTaskId) {
  const rt = stateByTaskId.get(task.id);
  return rt?.status === "done" || task.status === "done";
}

/**
 * Task concluída com sucesso (done, sem blocked/erro).
 * @param {object} task
 * @param {Map<string, object>} stateByTaskId
 */
export function isTaskSuccessfullyDone(task, stateByTaskId) {
  const rt = stateByTaskId.get(task.id);
  if (rt?.status === "blocked" || rt?.blockReason || rt?.failedStep) return false;
  if (rt?.status && rt.status !== "done") return false;
  return rt?.status === "done" || task.status === "done";
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function readMicroReleasesMap(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT micro_id, release_status, merged_at
     FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return new Map(rows.map((r) => [r.micro_id, r]));
}

/**
 * @param {string[]} approvedMicroIds
 * @param {Map<string, { release_status?: string, merged_at?: Date|null }>} releaseByMicro
 */
export function areAllApprovedMicrosReleased(approvedMicroIds, releaseByMicro) {
  if (!Array.isArray(approvedMicroIds) || approvedMicroIds.length === 0) return false;
  if (!releaseByMicro || releaseByMicro.size === 0) return false;
  return approvedMicroIds.every((id) => {
    const rel = releaseByMicro.get(id);
    return rel && (rel.release_status === "merged" || rel.merged_at != null);
  });
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function readApprovedMicroIds(tenantId, projectSlug) {
  return readMicrosFromVolume(tenantId, projectSlug)
    .filter((m) => m.approved === true && m.validationStatus === "approved")
    .map((m) => m.id);
}

/**
 * @param {object} task
 * @param {object|undefined} rt
 */
export function resolveEffectiveStatus(task, rt) {
  if (rt?.status === "done" || task.status === "done") return "done";
  if (rt?.status) return rt.status;
  return task.status || "todo";
}

/**
 * @param {object} task
 * @param {object|undefined} rt
 */
export function taskStatusSyncWarning(task, rt) {
  const rtDone = rt?.status === "done";
  const backlogDone = task.status === "done";
  if (rtDone && !backlogDone) {
    return "Runtime concluído, mas backlog ainda não está done — alinhe o backlog para desbloquear dependências.";
  }
  if (backlogDone && rt && rt.status !== "done") {
    return `Backlog done, runtime em ${rt.status} — sincronize tasks-state.json.`;
  }
  return null;
}

/**
 * Tasks elegíveis no A fazer para um micro.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export function getEligibleTodoTasks(tenantId, projectSlug, microId) {
  const backlog = readBacklogTasks(tenantId, projectSlug);
  const tasksState = readTasksState(tenantId, projectSlug);
  const stateByTaskId = new Map(tasksState.map((t) => [t.id, t]));
  const microTasks = backlog.filter((t) => t.sourceMicroId === microId);

  const paused = microTasks.filter((t) => {
    if (isTaskDone(t, stateByTaskId)) return false;
    const st = stateByTaskId.get(t.id);
    return st?.status === "paused" && st.lastCompletedStep;
  });
  const pausedIds = new Set(paused.map((t) => t.id));

  const todo = microTasks
    .filter((t) => {
      if (pausedIds.has(t.id)) return false;
      if (isTaskDone(t, stateByTaskId)) return false;
      if (t.status !== "todo" || t.approved !== true) return false;
      if (!taskDependenciesMet(t, backlog, stateByTaskId)) return false;
      const rt = stateByTaskId.get(t.id);
      if (rt && TERMINAL_RUNTIME.has(rt.status)) return false;
      return true;
    })
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  const seen = new Set();
  const eligible = [];
  for (const t of [...paused, ...todo]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    eligible.push(t);
  }

  return { eligible, backlog, stateByTaskId, microTasks };
}

function taskAutoRetryMax() {
  const raw = Number(process.env.TASK_AUTO_RETRY_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

function taskAutoRetryCooldownMs() {
  const raw = Number(process.env.TASK_AUTO_RETRY_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}

/**
 * Tasks bloqueadas elegíveis para retry automático no micro aberto.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export function getBlockedRetryableTasks(tenantId, projectSlug, microId) {
  const backlog = readBacklogTasks(tenantId, projectSlug);
  const tasksState = readTasksState(tenantId, projectSlug);
  const stateByTaskId = new Map(tasksState.map((t) => [t.id, t]));
  const tasks = backlog.filter((t) => t.sourceMicroId === microId);
  const maxRetries = taskAutoRetryMax();
  const cooldownMs = taskAutoRetryCooldownMs();
  const now = Date.now();

  return tasks
    .filter((t) => {
      const rt = stateByTaskId.get(t.id);
      if (!rt || rt.status !== "blocked") return false;
      const count = Number(rt.autoRetryCount) || 0;
      if (count >= maxRetries) return false;
      const last = rt.lastAutoRetryAt ? new Date(rt.lastAutoRetryAt).getTime() : 0;
      if (last > 0 && now - last < cooldownMs) return false;
      return true;
    })
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((t) => ({ task: t, runtime: stateByTaskId.get(t.id) }));
}

/**
 * Payload de retry (espelha handleRetryTask no front).
 * @param {object} runtime
 */
export function buildAutoRetryPayload(runtime) {
  const reason = runtime?.blockReason || null;
  const failed = runtime?.failedStep || null;
  const lastStep = runtime?.lastCompletedStep || null;
  /** @type {Record<string, string|boolean>} */
  const payload = { autoRetry: true };

  if (reason === "infra" && failed) {
    payload.retryMode = "infra";
    payload.failedStep = failed;
    if (lastStep) payload.retryFromStep = lastStep;
  } else {
    payload.retryMode = "agent";
    if (lastStep) payload.retryFromStep = lastStep;
  }
  return payload;
}

/**
 * Vista detalhada das tasks do micro aberto (dependências + elegibilidade para dispatch).
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export function getOpenMicroTasksDetail(tenantId, projectSlug, microId) {
  const { eligible, microTasks, stateByTaskId, backlog } = getEligibleTodoTasks(
    tenantId,
    projectSlug,
    microId
  );
  const eligibleIds = new Set(eligible.map((t) => t.id));

  function dependencyRows(task) {
    const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    return deps.map((depId) => {
      const rt = stateByTaskId.get(depId);
      const dep = backlog.find((t) => t.id === depId);
      const done = rt?.status === "done" || dep?.status === "done";
      return {
        id: depId,
        title: dep?.title || depId,
        done,
        status: rt?.status || dep?.status || "—",
      };
    });
  }

  function dispatchMeta(task) {
    const rt = stateByTaskId.get(task.id);
    if (isTaskDone(task, stateByTaskId)) {
      return { dispatchEligible: false, dispatchBlockReason: "Concluída" };
    }
    if (eligibleIds.has(task.id)) {
      return { dispatchEligible: true, dispatchBlockReason: null };
    }
    if (task.approved !== true) {
      return { dispatchEligible: false, dispatchBlockReason: "Aguarda aprovação do Tech Lead" };
    }
    if (rt && TERMINAL_RUNTIME.has(rt.status)) {
      return {
        dispatchEligible: false,
        dispatchBlockReason: `Em pipeline (${rt.status}) — ocupa slot de execução`,
      };
    }
    if (task.status !== "todo") {
      return {
        dispatchEligible: false,
        dispatchBlockReason: `Backlog: ${task.status} (só todo aprovado entra na fila)`,
      };
    }
    const pending = dependencyRows(task).filter((d) => !d.done);
    if (pending.length > 0) {
      return {
        dispatchEligible: false,
        dispatchBlockReason: `Depende de: ${pending.map((d) => d.id).join(", ")}`,
      };
    }
    return { dispatchEligible: false, dispatchBlockReason: "Não elegível para dispatch" };
  }

  const tasks = [...microTasks]
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((t) => {
      const rt = stateByTaskId.get(t.id);
      const meta = dispatchMeta(t);
      const effectiveStatus = resolveEffectiveStatus(t, rt);
      const syncWarning = taskStatusSyncWarning(t, rt);
      return {
        id: t.id,
        title: t.title,
        priority: t.priority ?? null,
        approved: t.approved === true,
        backlogStatus: t.status,
        runtimeStatus: rt?.status ?? null,
        effectiveStatus,
        statusInSync: !syncWarning,
        syncWarning,
        dependencies: dependencyRows(t),
        ...meta,
      };
    });

  return {
    microId,
    eligibleCount: eligible.length,
    totalCount: tasks.length,
    parallelHint:
      eligible.length === 0
        ? "Nenhuma task elegível agora — bots em Play não recebem jobs task até haver todo aprovado com dependências satisfeitas."
        : eligible.length === 1
          ? "1 task elegível — no máximo 1 bot task em paralelo neste micro (cadeia de dependências)."
          : `${eligible.length} tasks elegíveis — até ${eligible.length} bots podem correr tasks deste micro em paralelo.`,
    tasks,
  };
}

/**
 * Micro ainda com tasks não concluídas (backlog ou runtime).
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export function microHasUndeliveredTasks(tenantId, projectSlug, microId) {
  const backlog = readBacklogTasks(tenantId, projectSlug);
  const stateByTaskId = new Map(
    readTasksState(tenantId, projectSlug).map((t) => [t.id, t])
  );
  const microTasks = backlog.filter((t) => t.sourceMicroId === microId);
  if (microTasks.length === 0) return false;
  return microTasks.some((t) => {
    const rt = stateByTaskId.get(t.id);
    const status = rt?.status ?? t.status;
    return status !== "done";
  });
}

/**
 * Próximo micro aprovado sem tasks (para scope-tasks-only), após o micro aberto.
 * Só sugere quando o micro aberto não tem trabalho de entrega pendente.
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getNextMicroForTaskAnalysis(tenantId, projectSlug) {
  const wave = await getMicroWaveState(tenantId, projectSlug);
  const openId = wave.openMicroId;
  if (!openId) return null;

  const { eligible } = getEligibleTodoTasks(tenantId, projectSlug, openId);
  if (eligible.length > 0) return null;

  if (microHasUndeliveredTasks(tenantId, projectSlug, openId)) {
    return null;
  }

  const approved = wave.micros || [];
  const openIdx = approved.findIndex((m) => m.id === openId);
  if (openIdx < 0) return null;

  for (let i = openIdx + 1; i < approved.length; i += 1) {
    const m = approved[i];
    if (m.wavePhase === "released" || m.release) continue;
    const count = wave.taskCountByMicro?.[m.id] ?? 0;
    if (count === 0) return m.id;
  }
  return null;
}

export async function getMicroWaveState(tenantId, projectSlug) {
  const micros = readMicrosFromVolume(tenantId, projectSlug);
  const tasks = readBacklogTasks(tenantId, projectSlug);
  const { rows: releases } = await query(
    `SELECT micro_id, release_status, release_pr_url, release_pr_number, merged_at
     FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  const releaseByMicro = new Map(releases.map((r) => [r.micro_id, r]));

  const approved = micros
    .filter((m) => m.approved === true && m.validationStatus === "approved")
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  let openMicro = null;
  for (const m of approved) {
    const rel = releaseByMicro.get(m.id);
    if (rel) continue;
    if (!openMicro && ["open", "integrating", "qa_pending"].includes(m.wavePhase || m.taskDeliveryStatus || "")) {
      openMicro = { ...m, wavePhase: m.wavePhase || m.taskDeliveryStatus || "open", release: null };
      break;
    }
    if (!openMicro && (m.wavePhase || m.taskDeliveryStatus || "locked") !== "locked") {
      openMicro = { ...m, wavePhase: m.wavePhase || m.taskDeliveryStatus || "open", release: null };
      break;
    }
  }

  if (!openMicro) {
    for (const m of approved) {
      const rel = releaseByMicro.get(m.id);
      if (rel) continue;
      const prevDone = approved
        .filter((x) => (x.priority ?? 999) < (m.priority ?? 999))
        .every((x) => releaseByMicro.has(x.id));
      if (prevDone || approved.indexOf(m) === 0) {
        openMicro = {
          ...m,
          wavePhase: m.taskDeliveryStatus === "open" ? "open" : "locked",
          release: null,
        };
        break;
      }
    }
  }

  return {
    micros: approved.map((m) => ({
      id: m.id,
      title: m.title,
      taskDeliveryStatus: m.taskDeliveryStatus,
      wavePhase: releaseByMicro.has(m.id)
        ? "released"
        : m.wavePhase || m.taskDeliveryStatus,
      release: releaseByMicro.get(m.id) || null,
    })),
    openMicroId: openMicro?.id || null,
    openMicro,
    taskCountByMicro: Object.fromEntries(
      approved.map((m) => [
        m.id,
        tasks.filter((t) => t.sourceMicroId === m.id).length,
      ])
    ),
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ kind: string, taskId?: string, macroId?: string }} opts
 */
export async function assertMicroWaveAllowsJob(tenantId, projectSlug, opts) {
  const kind = opts.kind;
  if (kind === "provision" || kind === "tech-lead-review" || kind === "micro-integration-qa" || kind === "micro-release") {
    return;
  }

  const wave = await getMicroWaveState(tenantId, projectSlug);
  const openId = wave.openMicroId;

  if (kind === "scope") {
    return;
  }

  if (kind === "scope-tasks-only") {
    const targetMicroId = opts.microId || openId;
    if (!targetMicroId) {
      throw Object.assign(
        new Error("Nenhum micro para gerar tasks."),
        { status: 400, code: "no_open_micro" }
      );
    }
    const micros = readMicrosFromVolume(tenantId, projectSlug);
    const target = micros.find((m) => m.id === targetMicroId);
    if (!target || target.approved !== true || target.validationStatus !== "approved") {
      throw Object.assign(
        new Error(`Micro ${targetMicroId} não aprovado.`),
        { status: 400, code: "micro_not_approved" }
      );
    }
    const { rows: rel } = await query(
      `SELECT 1 FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2 AND micro_id = $3`,
      [tenantId, projectSlug, targetMicroId]
    );
    if (rel.length > 0) {
      throw Object.assign(
        new Error(`Micro ${targetMicroId} já tem release.`),
        { status: 400, code: "micro_released" }
      );
    }
    if (targetMicroId === openId) {
      const om = wave.openMicro;
      if (
        om?.wavePhase &&
        !["open"].includes(om.wavePhase) &&
        om.taskDeliveryStatus !== "open"
      ) {
        throw Object.assign(
          new Error(`Micro ${openId} não está em fase de desenvolvimento (open).`),
          { status: 400, code: "micro_not_open" }
        );
      }
    }
    return;
  }

  if (kind === "task" || kind === "develop") {
    if (!openId) {
      throw Object.assign(
        new Error("Aguarde o release do micro anterior em default antes de novas tasks."),
        { status: 400, code: "micro_locked" }
      );
    }
    if (opts.taskId) {
      const tasks = readBacklogTasks(tenantId, projectSlug);
      const task = tasks.find((t) => t.id === opts.taskId);
      if (task?.sourceMicroId && task.sourceMicroId !== openId) {
        throw Object.assign(
          new Error(
            `Task ${opts.taskId} pertence ao micro ${task.sourceMicroId}; apenas o micro ativo (${openId}) pode ser desenvolvido.`
          ),
          { status: 400, code: "wrong_micro" }
        );
      }
    }
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export async function checkMicroReadyForIntegrationQa(
  tenantId,
  projectSlug,
  microId
) {
  const { rows: relRows } = await query(
    `SELECT 1 FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2 AND micro_id = $3`,
    [tenantId, projectSlug, microId]
  );
  if (relRows.length > 0) return false;

  const tasks = readBacklogTasks(tenantId, projectSlug).filter(
    (t) => t.sourceMicroId === microId
  );
  if (tasks.length === 0) return false;

  const runtimeState = readTasksState(tenantId, projectSlug);
  const stateById = new Map(runtimeState.map((t) => [t.id, t]));
  const allDone = tasks.every((t) => {
    const rt = stateById.get(t.id);
    return rt?.status === "done" || t.status === "done";
  });
  if (!allDone) return false;

  return allMicroTaskPrsMerged(tenantId, projectSlug, microId);
}
