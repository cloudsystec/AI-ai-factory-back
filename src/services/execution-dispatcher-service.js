import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import {
  checkMicroReadyForIntegrationQa,
  getBlockedRetryableTasks,
  buildAutoRetryPayload,
  getDispatchEligibleTodoTasks,
  getMicroWaveState,
  getNextMicroForTaskAnalysis,
  microHasUndeliveredTasks,
} from "./micro-wave-service.js";
import { bumpAutoRetryForTask, readTasksState } from "./task-state-service.js";
import { isLockFree } from "./work-lock-service.js";
import { log } from "../lib/logger.js";
import { getProjectGitRow, setProjectGitLastError } from "./project-git-service.js";

/**
 * @param {string} message
 */
function managedGitFailureHint(message) {
  const m = String(message || "");
  if (/json web token could not be decoded/i.test(m)) {
    return `${m} — Verifique GITHUB_APP_PRIVATE_KEY no Railway (PEM RSA completo; use \\n entre linhas).`;
  }
  if (/bad credentials|401/i.test(m)) {
    return `${m} — Confirme GITHUB_APP_ID e chave privada da mesma GitHub App.`;
  }
  return m || "Não foi possível preparar o workspace.";
}

/**
 * @param {Error & { code?: string }} e
 */
function managedGitFailureCode(e) {
  const msg = String(e?.message || "");
  if (/json web token could not be decoded/i.test(msg)) return "github_jwt_invalid";
  if (e?.code) return String(e.code);
  return "managed_git_failed";
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {Record<string, unknown>} result
 */
async function attachGitDiag(tenantId, projectSlug, result) {
  const row = await getProjectGitRow(tenantId, projectSlug);
  if (!row) return result;
  return {
    ...result,
    gitStatus: row.git_status,
    gitLastError: row.git_last_error,
    repoMode: row.github_repo_mode,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} kind
 * @param {string} [taskId]
 */
async function hasActiveJob(tenantId, projectSlug, kind, taskId = null) {
  const params = [tenantId, projectSlug, kind];
  let sql = `SELECT 1 FROM jobs WHERE tenant_id = $1 AND project_slug = $2 AND kind = $3
     AND status IN ('queued', 'running', 'waiting_input')`;
  if (taskId) {
    sql += ` AND task_id = $4`;
    params.push(taskId);
  }
  sql += " LIMIT 1";
  const { rows } = await query(sql, params);
  return rows.length > 0;
}

/**

 * Jobs `task` que consomem workers (agentes em paralelo).
 */
/** Tasks realmente em execução (não conta queued). */
async function countRunningTaskJobs(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'task'
       AND status IN ('running', 'waiting_input')`,
    [tenantId, projectSlug]
  );
  return rows[0]?.n ?? 0;
}

/** Tasks já enfileiradas à espera de claim (ocupam vagas do pool). */
async function countQueuedTaskJobs(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'task'
       AND status = 'queued'`,
    [tenantId, projectSlug]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Vagas livres para novas tasks = bots em Play − (a correr + já na fila).
 * @param {number} playSlotsCount
 * @param {number} runningTasks
 * @param {number} queuedTasks
 */
function taskDispatchBudget(playSlotsCount, runningTasks, queuedTasks) {
  return Math.max(0, playSlotsCount - runningTasks - queuedTasks);
}

export async function reconcileTenantSlotsInUse(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND status IN ('running', 'waiting_input')`,
    [tenantId]
  );
  await query(
    `UPDATE tenants SET agent_slots_in_use = $2,
       has_active_job = ($2 > 0),
       updated_at = now()
     WHERE id = $1`,
    [tenantId, rows[0]?.n ?? 0]
  );
}

/** scope | scope-tasks-only | provision — no máximo um fluxo serial por projecto. */
async function hasActiveSerialJob(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT 1 FROM jobs WHERE tenant_id = $1 AND project_slug = $2
       AND kind IN ('scope', 'scope-tasks-only', 'provision', 'git-migrate')
       AND status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  return rows.length > 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
async function hasActiveMicroJob(tenantId, projectSlug, kind, microId) {
  const { rows } = await query(
    `SELECT 1 FROM jobs WHERE tenant_id = $1 AND project_slug = $2 AND kind = $3
       AND status IN ('queued', 'running', 'waiting_input')
       AND payload->>'microId' = $4
     LIMIT 1`,
    [tenantId, projectSlug, kind, microId]
  );
  return rows.length > 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} [microId]
 */
async function hasActiveScopeTasksOnlyJob(tenantId, projectSlug, microId = null) {
  const params = [tenantId, projectSlug];
  let sql = `SELECT 1 FROM jobs WHERE tenant_id = $1 AND project_slug = $2
     AND kind = 'scope-tasks-only'
     AND status IN ('queued', 'running', 'waiting_input')`;
  if (microId) {
    sql += ` AND payload->>'microId' = $3`;
    params.push(microId);
  }
  sql += " LIMIT 1";
  const { rows } = await query(sql, params);
  return rows.length > 0;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getExecutionState(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT continuous_active, pause_after_current, selected_worker_slots, macro_id,
            executor_user_id, updated_at
     FROM tenant_execution WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  return (
    rows[0] || {
      continuous_active: false,
      pause_after_current: false,
      selected_worker_slots: [],
      macro_id: projectSlug,
      executor_user_id: null,
    }
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ macroId?: string, workerSlots: number[], executorUserId?: string }} opts
 */
export async function startContinuousExecution(tenantId, projectSlug, opts) {
  const { assertProjectNotCompleted } = await import(
    "./project-completion-service.js"
  );
  await assertProjectNotCompleted(tenantId, projectSlug);

  const slots = (opts.workerSlots || []).filter((n) => n >= 1);
  await query(
    `INSERT INTO tenant_execution (tenant_id, project_slug, continuous_active, pause_after_current,
       selected_worker_slots, macro_id, executor_user_id, updated_at)
     VALUES ($1, $2, true, false, $3::jsonb, $4, $5, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       continuous_active = true,
       pause_after_current = false,
       selected_worker_slots = EXCLUDED.selected_worker_slots,
       macro_id = EXCLUDED.macro_id,
       executor_user_id = EXCLUDED.executor_user_id,
       updated_at = now()`,
    [
      tenantId,
      projectSlug,
      JSON.stringify(slots),
      opts.macroId || projectSlug,
      opts.executorUserId || null,
    ]
  );
  const dispatched = await dispatchQueuedWork(tenantId, projectSlug);
  return attachGitDiag(tenantId, projectSlug, {
    continuousActive: !dispatched.projectCompleted,
    workerSlots: dispatched.projectCompleted ? [] : slots,
    enqueued: dispatched.enqueued,
    hint: dispatched.hint,
    code: dispatched.code,
    phase: dispatched.phase,
    projectCompleted: dispatched.projectCompleted ?? false,
    completedAt: dispatched.completedAt ?? null,
  });
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function pauseContinuousExecution(tenantId, projectSlug) {
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
  return { pauseAfterCurrent: true, continuousActive: false, workerSlots: [] };
}

/**
 * Liga um worker (slot) ao pool do projecto — Play no card do bot.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} workerSlot
 * @param {{ macroId?: string, executorUserId?: string }} opts
 */
export async function startWorkerSlot(tenantId, projectSlug, workerSlot, opts = {}) {
  const slot = Number(workerSlot);
  if (!Number.isInteger(slot) || slot < 1) {
    throw Object.assign(new Error("worker_slot inválido"), { status: 400 });
  }
  const { assertBotsReadyForSlots } = await import("./worker-bot-service.js");
  await assertBotsReadyForSlots(tenantId, [slot]);

  const exec = await getExecutionState(tenantId, projectSlug);
  if (!exec.continuous_active) {
    return startContinuousExecution(tenantId, projectSlug, {
      macroId: opts.macroId || projectSlug,
      workerSlots: [slot],
      executorUserId: opts.executorUserId || null,
    });
  }

  return addWorkersToExecution(
    tenantId,
    projectSlug,
    [slot],
    opts.executorUserId || null
  );
}

/**
 * Desliga um worker do pool — Pause no card (job em curso termina; não enfileira mais).
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} workerSlot
 */
/**
 * Liga todos os bots configurados (botReady) ao pool do projecto.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ macroId?: string, executorUserId?: string }} opts
 */
export async function startAllReadyWorkers(tenantId, projectSlug, opts = {}) {
  const { listWorkersStatus } = await import("./worker-bot-service.js");
  const status = await listWorkersStatus(tenantId);
  const readySlots = status.workers
    .filter((w) => w.botReady)
    .map((w) => w.slot);
  if (readySlots.length === 0) {
    throw Object.assign(
      new Error("Nenhum bot configurado. Contate o administrador da plataforma."),
      { status: 403, code: "bot_not_configured" }
    );
  }

  const exec = await getExecutionState(tenantId, projectSlug);
  if (!exec.continuous_active) {
    return startContinuousExecution(tenantId, projectSlug, {
      macroId: opts.macroId || projectSlug,
      workerSlots: readySlots,
      executorUserId: opts.executorUserId || null,
    });
  }
  return addWorkersToExecution(
    tenantId,
    projectSlug,
    readySlots,
    opts.executorUserId || null
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} workerSlot
 */
export async function stopWorkerSlot(tenantId, projectSlug, workerSlot) {
  const slot = Number(workerSlot);
  if (!Number.isInteger(slot) || slot < 1) {
    throw Object.assign(new Error("worker_slot inválido"), { status: 400 });
  }

  const exec = await getExecutionState(tenantId, projectSlug);
  const current = Array.isArray(exec.selected_worker_slots)
    ? exec.selected_worker_slots
    : JSON.parse(exec.selected_worker_slots || "[]");
  const next = current.filter((n) => n !== slot);

  if (next.length === 0) {
    return pauseContinuousExecution(tenantId, projectSlug);
  }

  await query(
    `UPDATE tenant_execution
     SET selected_worker_slots = $3::jsonb, updated_at = now()
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug, JSON.stringify(next)]
  );

  log.info("Worker removido do pool", { project: projectSlug, slot, remaining: next });

  return {
    continuousActive: true,
    pauseAfterCurrent: false,
    workerSlots: next,
    enqueued: [],
    hint: null,
  };
}

/**
 * Adiciona slots ao pool de execução em curso sem interromper workers activos.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number[]} newSlots
 * @param {string|null} executorUserId
 */
export async function addWorkersToExecution(tenantId, projectSlug, newSlots, executorUserId = null) {
  const exec = await getExecutionState(tenantId, projectSlug);
  if (!exec.continuous_active) {
    throw new Error("Execução não está ativa. Use start primeiro.");
  }

  const current = Array.isArray(exec.selected_worker_slots)
    ? exec.selected_worker_slots
    : JSON.parse(exec.selected_worker_slots || "[]");
  const merged = [...new Set([...current, ...newSlots.filter((n) => n >= 1)])].sort((a, b) => a - b);

  await query(
    `UPDATE tenant_execution
     SET selected_worker_slots = $3::jsonb, updated_at = now()
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug, JSON.stringify(merged)]
  );

  log.info("Workers adicionados ao pool", {
    project: projectSlug,
    previous: current,
    merged,
  });

  const dispatched = await dispatchQueuedWork(tenantId, projectSlug);
  return attachGitDiag(tenantId, projectSlug, {
    continuousActive: dispatched.projectCompleted ? false : true,
    workerSlots: dispatched.projectCompleted ? [] : merged,
    enqueued: dispatched.enqueued,
    hint: dispatched.hint,
    code: dispatched.code,
    phase: dispatched.phase,
    projectCompleted: dispatched.projectCompleted ?? false,
    completedAt: dispatched.completedAt ?? null,
  });
}

/**
 * Enfileira retry automático para tasks bloqueadas quando não há trabalho elegível.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 * @param {string} macroId
 * @param {string|null} executorUserId
 * @param {number} slotBudget
 */
async function tryEnqueueAutoRetryBlocked(
  tenantId,
  projectSlug,
  microId,
  macroId,
  executorUserId,
  slotBudget
) {
  if (slotBudget <= 0) return { enqueued: [], hint: null };

  const blocked = getBlockedRetryableTasks(tenantId, projectSlug, microId);
  const enqueued = [];

  for (const { task, runtime } of blocked) {
    if (enqueued.length >= slotBudget) break;
    if (await hasActiveJob(tenantId, projectSlug, "task", task.id)) continue;

    const taskLock = `${projectSlug}:${task.id}`;
    if (!(await isLockFree(tenantId, "task", taskLock))) continue;

    const payload = buildAutoRetryPayload(runtime);
    const id = randomUUID();
    await query(
      `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, task_id, status, payload, requested_by_user_id)
       VALUES ($1, $2, $3, 'task', $4, $5, 'queued', $6::jsonb, $7)`,
      [
        id,
        tenantId,
        projectSlug,
        macroId,
        task.id,
        JSON.stringify(payload),
        executorUserId,
      ]
    );
    bumpAutoRetryForTask(tenantId, projectSlug, task.id);
    enqueued.push({
      jobId: id,
      kind: "task",
      taskId: task.id,
      autoRetry: true,
      retryMode: payload.retryMode,
    });
    log.info("Auto-retry task bloqueada", {
      project: projectSlug,
      taskId: task.id,
      jobId: id,
      retryMode: payload.retryMode,
      blockReason: runtime?.blockReason || "—",
    });
  }

  if (enqueued.length > 0) {
    return { enqueued, hint: null };
  }
  return { enqueued: [], hint: null };
}

/**
 * Enfileira trabalho automático conforme estado do projeto (simplificado).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function dispatchQueuedWork(tenantId, projectSlug) {
  const result = await dispatchQueuedWorkInternal(tenantId, projectSlug);
  return finalizeDispatchIfIdleComplete(tenantId, projectSlug, result);
}

/**
 * Se o dispatch não enfileirou nada e o projecto está 100% concluído, finaliza-o.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ enqueued?: object[], hint?: string|null, projectCompleted?: boolean }} result
 */
async function finalizeDispatchIfIdleComplete(tenantId, projectSlug, result) {
  if (result.projectCompleted) return result;
  if (Array.isArray(result.enqueued) && result.enqueued.length > 0) return result;

  const { rows } = await query(
    `SELECT 1 FROM jobs WHERE tenant_id = $1 AND project_slug = $2
       AND status IN ('queued', 'running', 'waiting_input')
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  if (rows.length > 0) return result;

  const { tryCompleteProjectFromLiveState } = await import(
    "./project-completion-service.js"
  );
  const completion = await tryCompleteProjectFromLiveState(tenantId, projectSlug);
  if (!completion.completed) return result;

  return {
    enqueued: [],
    hint: "Projeto finalizado — todas as micros e tasks concluídas.",
    projectCompleted: true,
    completedAt: completion.completedAt ?? null,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function dispatchQueuedWorkInternal(tenantId, projectSlug) {
  try {
    const { assertProjectNotCompleted } = await import(
      "./project-completion-service.js"
    );
    await assertProjectNotCompleted(tenantId, projectSlug);
  } catch (e) {
    if (e.code === "project_completed") {
      return { enqueued: [], hint: "Projeto finalizado." };
    }
    throw e;
  }

  // Limpar jobs "running" presos há mais de 10 minutos (stale)
  await query(
    `UPDATE jobs SET status = 'failed', finished_at = now()
     WHERE tenant_id = $1 AND project_slug = $2
       AND status = 'running'
       AND started_at < now() - interval '10 minutes'`,
    [tenantId, projectSlug]
  );

  // Liberar work_locks cujo job já terminou (órfãos)
  await query(
    `DELETE FROM work_locks wl
     WHERE wl.tenant_id = $1 AND wl.project_slug = $2
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.id = wl.job_id AND j.status IN ('queued', 'running', 'waiting_input')
       )`,
    [tenantId, projectSlug]
  );

  await reconcileTenantSlotsInUse(tenantId);

  const exec = await getExecutionState(tenantId, projectSlug);
  if (!exec.continuous_active || exec.pause_after_current) {
    return { enqueued: [], hint: null };
  }

  const executorUserId = exec.executor_user_id || null;
  const slots = Array.isArray(exec.selected_worker_slots)
    ? exec.selected_worker_slots
    : JSON.parse(exec.selected_worker_slots || "[]");

  if (slots.length === 0) {
    return {
      enqueued: [],
      hint: "Selecione pelo menos um worker livre antes do Play.",
    };
  }

  const gitRow = await getProjectGitRow(tenantId, projectSlug);
  if (gitRow && gitRow.git_status !== "ready") {
    if (gitRow.git_status === "not_connected") {
      const { ensureManagedGitRepository } = await import(
        "./managed-git-service.js"
      );
      try {
        await ensureManagedGitRepository(tenantId, projectSlug);
      } catch (e) {
        const hint = managedGitFailureHint(e.message);
        const code = managedGitFailureCode(e);
        log.error("Falha ao criar repo managed", {
          project: projectSlug,
          error: e.message,
          code,
        });
        await setProjectGitLastError(tenantId, projectSlug, hint);
        return {
          enqueued: [],
          hint,
          code,
          phase: "managed_git_create",
        };
      }
    }

    const freshGit = await getProjectGitRow(tenantId, projectSlug);
    if (freshGit?.git_status === "migrating") {
      const { ensureGitMigrateJob } = await import("./git-migrate-service.js");
      const mig = await ensureGitMigrateJob(tenantId, projectSlug);
      if (mig?.jobId) {
        return {
          enqueued: [{ jobId: mig.jobId, kind: "git-migrate" }],
          hint: null,
        };
      }
      return { enqueued: [], hint: "A migrar repositório…" };
    }

    const { ensureGitProvisionJob } = await import("./git-provision-service.js");
    const prov = await ensureGitProvisionJob(tenantId, projectSlug);
    if (prov?.jobId) {
      return {
        enqueued: [{ jobId: prov.jobId, kind: "provision" }],
        hint: null,
        phase: "git_provision",
      };
    }
    return {
      enqueued: [],
      hint: "A preparar workspace…",
      phase: "git_provision_wait",
    };
  }

  const wave = await getMicroWaveState(tenantId, projectSlug);
  const enqueued = [];
  const macroId = exec.macro_id || projectSlug;
  const serialBusy = await hasActiveSerialJob(tenantId, projectSlug);

  if (
    !serialBusy &&
    (await isLockFree(tenantId, "scope", `${projectSlug}:${macroId}`))
  ) {
    const micros = wave.micros || [];
    if (micros.length === 0) {
      const id = randomUUID();
      await query(
        `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, requested_by_user_id)
         VALUES ($1, $2, $3, 'scope', $4, 'queued', $5)`,
        [id, tenantId, projectSlug, macroId, executorUserId]
      );
      enqueued.push({ jobId: id, kind: "scope" });
      log.info("Job enfileirado (escopo macro)", { project: projectSlug, jobId: id });
      return { enqueued, hint: null };
    }
  }

  const openId = wave.openMicroId;
  if (openId) {
    const lockKey = `${projectSlug}:${openId}`;
    const taskCount = wave.taskCountByMicro?.[openId] ?? 0;

    if (
      !serialBusy &&
      taskCount === 0 &&
      !microHasUndeliveredTasks(tenantId, projectSlug, openId) &&
      !(await hasActiveScopeTasksOnlyJob(tenantId, projectSlug, openId)) &&
      (await isLockFree(tenantId, "micro_tasks", lockKey))
    ) {
      const id = randomUUID();
      await query(
        `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, payload, requested_by_user_id)
         VALUES ($1, $2, $3, 'scope-tasks-only', $4, 'queued', $5::jsonb, $6)`,
        [
          id,
          tenantId,
          projectSlug,
          macroId,
          JSON.stringify({ microId: openId }),
          executorUserId,
        ]
      );
      enqueued.push({ jobId: id, kind: "scope-tasks-only", microId: openId });
      log.info("Job enfileirado (tasks micro aberto)", {
        project: projectSlug,
        microId: openId,
        jobId: id,
      });
      return { enqueued, hint: null };
    }

    const { eligible, stateByTaskId, microTasks } = await getDispatchEligibleTodoTasks(
      tenantId,
      projectSlug,
      openId
    );

    if (eligible.length > 0) {
      const runningTasks = await countRunningTaskJobs(tenantId, projectSlug);
      const queuedTasks = await countQueuedTaskJobs(tenantId, projectSlug);
      let budget = taskDispatchBudget(slots.length, runningTasks, queuedTasks);

      for (const task of eligible) {
        if (budget <= 0) break;
        const taskLock = `${projectSlug}:${task.id}`;
        if (!(await isLockFree(tenantId, "task", taskLock))) continue;
        if (await hasActiveJob(tenantId, projectSlug, "task", task.id)) {
          continue;
        }

        const st = stateByTaskId.get(task.id);
        const isPaused = st?.status === "paused";
        const resumeStep = isPaused ? st.lastCompletedStep : null;

        const id = randomUUID();
        const payload = resumeStep
          ? JSON.stringify({ resumeFromStep: resumeStep })
          : null;
        await query(
          `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, task_id, status, payload, requested_by_user_id)
           VALUES ($1, $2, $3, 'task', $4, $5, 'queued', $6::jsonb, $7)`,
          [id, tenantId, projectSlug, macroId, task.id, payload, executorUserId]
        );
        enqueued.push({ jobId: id, kind: "task", taskId: task.id, resumeFromStep: resumeStep });
        log.info(isPaused ? "Task retomada (pausada)" : "Task enfileirada (A fazer, paralelo)", {
          project: projectSlug,
          taskId: task.id,
          jobId: id,
          ...(resumeStep ? { resumeFromStep: resumeStep } : {}),
        });
        budget -= 1;
      }

      if (enqueued.length > 0) {
        return { enqueued, hint: null };
      }

      const hintBusy =
        runningTasks + queuedTasks >= slots.length
          ? `${runningTasks} a correr · ${queuedTasks} na fila · ${slots.length} bot(s) em Play — aguarde ou use ▶ Todos nos bots livres.`
          : "Tasks no A fazer, mas locks ou jobs duplicados impedem enfileirar.";

      return {
        enqueued: [],
        hint: hintBusy,
      };
    }

    const runningTasks = await countRunningTaskJobs(tenantId, projectSlug);
    const queuedTasks = await countQueuedTaskJobs(tenantId, projectSlug);
    const retryBudget = taskDispatchBudget(slots.length, runningTasks, queuedTasks);
    const autoRetry = await tryEnqueueAutoRetryBlocked(
      tenantId,
      projectSlug,
      openId,
      macroId,
      executorUserId,
      retryBudget
    );
    if (autoRetry.enqueued.length > 0) {
      return autoRetry;
    }

    /** Micro concluído: todas as tasks done → release do micro (QA já ocorreu na task de fechamento). */
    const allDone =
      microTasks.length > 0 &&
      microTasks.every((t) => {
        const rt = stateByTaskId.get(t.id);
        return rt?.status === "done" || t.status === "done";
      });

    if (
      allDone &&
      (await checkMicroReadyForIntegrationQa(tenantId, projectSlug, openId))
    ) {
      if (!(await hasActiveMicroJob(tenantId, projectSlug, "micro-release", openId))) {
        const id = randomUUID();
        await query(
          `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, payload, requested_by_user_id)
           VALUES ($1, $2, $3, 'micro-release', $4, 'queued', $5::jsonb, $6)`,
          [
            id,
            tenantId,
            projectSlug,
            macroId,
            JSON.stringify({ projectSlug, microId: openId }),
            executorUserId,
          ]
        );
        enqueued.push({ jobId: id, kind: "micro-release", microId: openId });
        log.info("Release do micro (pós-QA na task de fechamento)", {
          project: projectSlug,
          microId: openId,
          jobId: id,
        });
        return { enqueued, hint: null };
      }
      return {
        enqueued: [],
        hint: `Micro ${openId}: release em curso.`,
      };
    }

    if (allDone && microTasks.length > 0) {
      return {
        enqueued: [],
        hint: `Micro ${openId}: aguardando merge Tech Lead de todas as PRs em tech-lead.`,
      };
    }

    const nextMicroId = await getNextMicroForTaskAnalysis(tenantId, projectSlug);
    if (
      nextMicroId &&
      !serialBusy &&
      !(await hasActiveScopeTasksOnlyJob(tenantId, projectSlug, nextMicroId))
    ) {
      const nextLock = `${projectSlug}:${nextMicroId}`;
      if (await isLockFree(tenantId, "micro_tasks", nextLock)) {
        const id = randomUUID();
        await query(
          `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, payload, requested_by_user_id)
           VALUES ($1, $2, $3, 'scope-tasks-only', $4, 'queued', $5::jsonb, $6)`,
          [
            id,
            tenantId,
            projectSlug,
            macroId,
            JSON.stringify({ microId: nextMicroId }),
            executorUserId,
          ]
        );
        enqueued.push({
          jobId: id,
          kind: "scope-tasks-only",
          microId: nextMicroId,
        });
        log.info("Job enfileirado (análise próximo micro)", {
          project: projectSlug,
          microId: nextMicroId,
          jobId: id,
        });
        return { enqueued, hint: null };
      }
    }

    return {
      enqueued: [],
      hint: `Micro ${openId} aberto sem tasks no A fazer (todo aprovadas). Gere tasks ou aguarde dependências.`,
    };
  }

  return {
    enqueued: [],
    hint:
      "Nenhum micro em fase aberta. Conclua o escopo ou aguarde a priorização das ondas.",
  };
}
