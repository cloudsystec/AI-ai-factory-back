import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { query } from "../db/pool.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import { broadcast } from "../lib/ws-hub.js";
import {
  readBacklogTasks,
  readMicrosFromVolume,
} from "./micro-wave-service.js";
import { readTasksState, writeTasksState } from "./task-state-service.js";
import { upsertDashboardSnapshot } from "./project-dashboard-service.js";
import {
  readLiveScopeState,
  readLiveTasks,
} from "./workspace-dashboard-reader.js";
import { queueJob } from "./job-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_DIR = path.resolve(
  __dirname,
  "../../../ai-factory-cli/orchestrator"
);

const TERMINAL_RUNTIME = new Set([
  "done",
  "blocked",
  "running",
  "review",
  "testing",
  "development",
  "planning",
]);

const TASK_PATCH_KEYS = new Set([
  "title",
  "description",
  "acceptance",
  "priority",
  "dependencies",
  "testStrategy",
]);

const MICRO_PATCH_KEYS = new Set([
  "title",
  "description",
  "risks",
  "dependencies",
]);

/** @type {Promise<{ readBacklogFile: Function, writeBacklogFile: Function, readMicrosFromPath: Function, writeMicrosToPath: Function }>|null} */
let orchestratorIo = null;

async function loadOrchestratorIo() {
  if (!orchestratorIo) {
    const base = pathToFileURL(ORCHESTRATOR_DIR).href;
    const [backlogMod, microMod] = await Promise.all([
      import(`${base}/backlog-io.js`),
      import(`${base}/micro-delivery.js`),
    ]);
    orchestratorIo = Promise.resolve({
      readBacklogFile: backlogMod.readBacklogFile,
      writeBacklogFile: backlogMod.writeBacklogFile,
      readMicrosFromPath: microMod.readMicrosFromPath,
      writeMicrosToPath: microMod.writeMicrosToPath,
    });
  }
  return orchestratorIo;
}

function backlogPath(tenantId, projectSlug) {
  return path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "backlog",
    `${projectSlug}.tasks.json`
  );
}

function microPath(tenantId, projectSlug) {
  return path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "scopes",
    "micro",
    `${projectSlug}.micro.json`
  );
}

/**
 * @param {object} task
 * @param {object|undefined} runtime
 */
export function isTaskDevelopmentStarted(task, runtime) {
  if (!runtime) return false;
  if (runtime.lastCompletedStep) return true;
  if (runtime.status && TERMINAL_RUNTIME.has(runtime.status)) return true;
  if (runtime.currentAgent && runtime.currentAgent !== "Done") return true;
  return false;
}

/**
 * @param {object} task
 * @param {object|undefined} runtime
 */
export function isTaskEditable(task, runtime) {
  if (task.status !== "todo") return false;
  if (task.approved !== true) return false;
  if (isTaskDevelopmentStarted(task, runtime)) return false;
  return true;
}

/**
 * @param {object} task
 * @param {object|undefined} runtime
 */
export function getTaskEditBlockReason(task, runtime) {
  if (task.status !== "todo") {
    return { code: "TASK_NOT_IN_TODO", message: `Backlog em "${task.status}" (só "A fazer" / todo).` };
  }
  if (task.approved !== true) {
    return {
      code: "TASK_NOT_APPROVED",
      message: "Task ainda não aprovada pelo Tech Lead.",
    };
  }
  if (isTaskDevelopmentStarted(task, runtime)) {
    const st = runtime?.status || runtime?.currentAgent || "em curso";
    return {
      code: "TASK_DEV_STARTED",
      message: `Desenvolvimento já iniciado (${st}).`,
    };
  }
  return null;
}

/**
 * @param {object[]} microTasks
 * @param {Map<string, object>} stateByTaskId
 */
export function isMicroEditable(microTasks, stateByTaskId) {
  return microTasks.every(
    (t) => !isTaskDevelopmentStarted(t, stateByTaskId.get(t.id))
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function assertProjectExists(tenantId, projectSlug) {
  const { rows } = await query(
    "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, projectSlug]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function assertProjectEditable(tenantId, projectSlug) {
  await assertProjectExists(tenantId, projectSlug);
  const { assertProjectNotCompleted } = await import(
    "./project-completion-service.js"
  );
  await assertProjectNotCompleted(tenantId, projectSlug);
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} [microId]
 */
async function assertNoActiveScopeJob(tenantId, projectSlug, microId) {
  const { rows } = await query(
    `SELECT id, kind, payload FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2
       AND kind IN ('scope', 'scope-tasks-only')
       AND status IN ('queued', 'running', 'waiting_input')`,
    [tenantId, projectSlug]
  );
  for (const row of rows) {
    const payloadMicro =
      row.payload && typeof row.payload === "object"
        ? row.payload.microId
        : null;
    if (!microId || payloadMicro === microId || row.kind === "scope") {
      throw Object.assign(
        new Error("Há um job de escopo em execução neste projeto."),
        { status: 409, code: "MICRO_JOB_ACTIVE" }
      );
    }
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
async function assertTaskNotLocked(tenantId, projectSlug, taskId) {
  const { rows } = await query(
    `SELECT j.id FROM jobs j
     WHERE j.tenant_id = $1 AND j.project_slug = $2 AND j.task_id = $3
       AND j.status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, projectSlug, taskId]
  );
  if (rows[0]) {
    throw Object.assign(
      new Error("Task com job ativo — aguarde ou cancele antes de editar."),
      { status: 409, code: "TASK_JOB_ACTIVE" }
    );
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function readMicroReleasesSet(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT micro_id, release_status, merged_at
     FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return new Map(rows.map((r) => [r.micro_id, r]));
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getEditabilityReport(tenantId, projectSlug) {
  if (!isValidProjectSlug(projectSlug)) {
    throw Object.assign(new Error("Slug inválido"), { status: 400 });
  }
  await assertProjectExists(tenantId, projectSlug);

  const backlog = readBacklogTasks(tenantId, projectSlug);
  const runtime = readTasksState(tenantId, projectSlug);
  const stateByTaskId = new Map(runtime.map((t) => [t.id, t]));
  const micros = readMicrosFromVolume(tenantId, projectSlug);
  const releases = await readMicroReleasesSet(tenantId, projectSlug);

  const tasks = backlog.map((task) => {
    const rt = stateByTaskId.get(task.id);
    const block = getTaskEditBlockReason(task, rt);
    return {
      id: task.id,
      title: task.title,
      sourceMicroId: task.sourceMicroId ?? null,
      editable: !block,
      blockReason: block?.message ?? null,
      blockCode: block?.code ?? null,
    };
  });

  const microReports = micros.map((micro) => {
    const microTasks = backlog.filter((t) => t.sourceMicroId === micro.id);
    const rel = releases.get(micro.id);
    const released = rel && (rel.release_status === "merged" || rel.merged_at);
    let editable = false;
    let blockReason = null;
    let blockCode = null;

    if (released) {
      blockCode = "MICRO_RELEASED";
      blockReason = "Micro já teve release merged.";
    } else if (micro.approved !== true || micro.validationStatus !== "approved") {
      blockCode = "MICRO_NOT_APPROVED";
      blockReason = "Micro ainda não aprovado.";
    } else if (!isMicroEditable(microTasks, stateByTaskId)) {
      blockCode = "MICRO_HAS_DEV_STARTED";
      blockReason = "Alguma task deste micro já iniciou desenvolvimento.";
    } else {
      editable = true;
    }

    return {
      id: micro.id,
      title: micro.title,
      editable,
      blockReason,
      blockCode,
      taskCount: microTasks.length,
      tasksWouldBeRemoved: editable ? microTasks.length : 0,
    };
  });

  return {
    projectSlug,
    tasks,
    micros: microReports,
    editableTaskCount: tasks.filter((t) => t.editable).length,
    editableMicroCount: microReports.filter((m) => m.editable).length,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function refreshProjectDashboard(tenantId, projectSlug) {
  const [tasksLive, scopeLive] = await Promise.all([
    readLiveTasks(tenantId, projectSlug),
    readLiveScopeState(tenantId, projectSlug),
  ]);
  if (!tasksLive.ok || !scopeLive.ok) {
    throw Object.assign(
      new Error(
        tasksLive.error ||
          scopeLive.error ||
          "Falha ao reconstruir snapshot do dashboard."
      ),
      { status: 500 }
    );
  }
  await upsertDashboardSnapshot(
    tenantId,
    projectSlug,
    tasksLive.tasks,
    scopeLive.scopeState
  );
  broadcast(tenantId, { type: "dashboard", project: projectSlug });
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @param {Record<string, unknown>} patch
 */
export async function updateTaskFields(tenantId, projectSlug, taskId, patch) {
  if (!isValidProjectSlug(projectSlug)) {
    throw Object.assign(new Error("Slug inválido"), { status: 400 });
  }
  const tid = String(taskId ?? "").trim();
  if (!tid) {
    throw Object.assign(new Error("taskId obrigatório"), { status: 400 });
  }

  await assertProjectEditable(tenantId, projectSlug);
  await assertTaskNotLocked(tenantId, projectSlug, tid);

  const io = await loadOrchestratorIo();
  const bp = backlogPath(tenantId, projectSlug);
  if (!fs.existsSync(bp)) {
    throw Object.assign(new Error("Backlog não encontrado"), { status: 404 });
  }

  const doc = io.readBacklogFile(bp, {
    project: projectSlug,
    macroId: projectSlug,
  });
  const idx = doc.tasks.findIndex((t) => t.id === tid);
  if (idx < 0) {
    throw Object.assign(new Error("Task não encontrada"), { status: 404 });
  }

  const task = doc.tasks[idx];
  const runtime = readTasksState(tenantId, projectSlug);
  const rt = runtime.find((t) => t.id === tid);
  const block = getTaskEditBlockReason(task, rt);
  if (block) {
    throw Object.assign(new Error(block.message), {
      status: 409,
      code: block.code,
    });
  }

  const keys = Object.keys(patch || {});
  if (keys.length === 0) {
    throw Object.assign(new Error("Nada para atualizar"), { status: 400 });
  }
  for (const key of keys) {
    if (!TASK_PATCH_KEYS.has(key)) {
      throw Object.assign(new Error(`Campo não permitido: ${key}`), {
        status: 400,
        code: "INVALID_FIELD",
      });
    }
  }

  const updated = { ...task };
  if (patch.title !== undefined) {
    const title = String(patch.title ?? "").trim();
    if (!title) {
      throw Object.assign(new Error("title não pode estar vazio"), { status: 400 });
    }
    updated.title = title;
  }
  if (patch.description !== undefined) {
    updated.description = String(patch.description ?? "").trim();
  }
  if (patch.acceptance !== undefined) {
    updated.acceptance = patch.acceptance;
  }
  if (patch.priority !== undefined) {
    updated.priority = Number(patch.priority);
  }
  if (patch.dependencies !== undefined) {
    if (!Array.isArray(patch.dependencies)) {
      throw Object.assign(new Error("dependencies deve ser array"), { status: 400 });
    }
    updated.dependencies = patch.dependencies.map(String);
  }
  if (patch.testStrategy !== undefined) {
    updated.testStrategy = String(patch.testStrategy ?? "").trim();
  }

  doc.tasks[idx] = updated;
  io.writeBacklogFile(bp, doc);
  await refreshProjectDashboard(tenantId, projectSlug);

  return { ok: true, task: updated };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 * @param {Record<string, unknown>} patch
 * @param {string} [userInstructions]
 * @param {string|null} [userId]
 */
export async function updateMicroAndRegenerateTasks(
  tenantId,
  projectSlug,
  microId,
  patch,
  userInstructions = "",
  userId = null
) {
  if (!isValidProjectSlug(projectSlug)) {
    throw Object.assign(new Error("Slug inválido"), { status: 400 });
  }
  const mid = String(microId ?? "").trim();
  if (!mid) {
    throw Object.assign(new Error("microId obrigatório"), { status: 400 });
  }

  await assertProjectEditable(tenantId, projectSlug);
  await assertNoActiveScopeJob(tenantId, projectSlug, mid);

  const io = await loadOrchestratorIo();
  const mp = microPath(tenantId, projectSlug);
  if (!fs.existsSync(mp)) {
    throw Object.assign(new Error("Microescopos não encontrados"), { status: 404 });
  }

  const micros = io.readMicrosFromPath(mp);
  const microIdx = micros.findIndex((m) => m.id === mid);
  if (microIdx < 0) {
    throw Object.assign(new Error("Micro não encontrado"), { status: 404 });
  }

  const micro = micros[microIdx];
  const releases = await readMicroReleasesSet(tenantId, projectSlug);
  const rel = releases.get(mid);
  if (rel && (rel.release_status === "merged" || rel.merged_at)) {
    throw Object.assign(new Error("Micro já teve release merged."), {
      status: 409,
      code: "MICRO_RELEASED",
    });
  }
  if (micro.approved !== true || micro.validationStatus !== "approved") {
    throw Object.assign(new Error("Micro ainda não aprovado."), {
      status: 409,
      code: "MICRO_NOT_APPROVED",
    });
  }

  const backlog = readBacklogTasks(tenantId, projectSlug);
  const microTasks = backlog.filter((t) => t.sourceMicroId === mid);
  const runtime = readTasksState(tenantId, projectSlug);
  const stateByTaskId = new Map(runtime.map((t) => [t.id, t]));

  if (!isMicroEditable(microTasks, stateByTaskId)) {
    throw Object.assign(
      new Error("Alguma task deste micro já iniciou desenvolvimento."),
      { status: 409, code: "MICRO_HAS_DEV_STARTED" }
    );
  }

  const keys = Object.keys(patch || {});
  for (const key of keys) {
    if (!MICRO_PATCH_KEYS.has(key)) {
      throw Object.assign(new Error(`Campo não permitido: ${key}`), {
        status: 400,
        code: "INVALID_FIELD",
      });
    }
  }

  const updatedMicro = { ...micro };
  if (patch.title !== undefined) {
    const title = String(patch.title ?? "").trim();
    if (!title) {
      throw Object.assign(new Error("title não pode estar vazio"), { status: 400 });
    }
    updatedMicro.title = title;
  }
  if (patch.description !== undefined) {
    updatedMicro.description = String(patch.description ?? "").trim();
  }
  if (patch.risks !== undefined) {
    updatedMicro.risks = String(patch.risks ?? "").trim();
  }
  if (patch.dependencies !== undefined) {
    if (!Array.isArray(patch.dependencies)) {
      throw Object.assign(new Error("dependencies deve ser array"), { status: 400 });
    }
    updatedMicro.dependencies = patch.dependencies.map(String);
  }

  micros[microIdx] = updatedMicro;
  io.writeMicrosToPath(mp, micros);

  const removedTaskIds = microTasks.map((t) => t.id);
  const bp = backlogPath(tenantId, projectSlug);
  const doc = io.readBacklogFile(bp, {
    project: projectSlug,
    macroId: projectSlug,
  });
  doc.tasks = doc.tasks.filter((t) => t.sourceMicroId !== mid);
  io.writeBacklogFile(bp, doc);

  const nextRuntime = runtime.filter((t) => !removedTaskIds.includes(t.id));
  writeTasksState(tenantId, projectSlug, nextRuntime);

  await refreshProjectDashboard(tenantId, projectSlug);

  const instructions = String(userInstructions ?? "").trim();
  const job = await queueJob(
    tenantId,
    {
      kind: "scope-tasks-only",
      project: projectSlug,
      microId: mid,
      payload: {
        microId: mid,
        replaceMicroTasks: true,
        copilotInstructions: instructions || undefined,
      },
    },
    { requestedByUserId: userId }
  );

  return {
    ok: true,
    micro: updatedMicro,
    removedTaskIds,
    removedTaskCount: removedTaskIds.length,
    jobId: job.jobId,
    message:
      removedTaskIds.length > 0
        ? `${removedTaskIds.length} task(s) removida(s); job ${job.jobId} enfileirado para regenerar.`
        : `Job ${job.jobId} enfileirado para gerar tasks.`,
  };
}
