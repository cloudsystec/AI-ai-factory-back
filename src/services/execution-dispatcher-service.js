import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import {
  checkMicroReadyForIntegrationQa,
  getMicroWaveState,
  readBacklogTasks,
} from "./micro-wave-service.js";
import { readTasksState } from "./task-state-service.js";
import { isLockFree } from "./work-lock-service.js";
import { log } from "../lib/logger.js";
import { getProjectGitRow } from "./project-git-service.js";

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
 * @param {object} task
 * @param {object[]} backlogTasks
 */
function taskDependenciesMet(task, backlogTasks, stateByTaskId) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  if (deps.length === 0) return true;
  return deps.every((depId) => {
    const rt = stateByTaskId?.get(depId);
    if (rt?.status === "done") return true;
    const dep = backlogTasks.find((t) => t.id === depId);
    return dep?.status === "done";
  });
}

/**
 * Jobs `task` que consomem workers (agentes em paralelo).
 */
async function countActiveTaskJobs(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'task'
       AND status IN ('queued', 'running', 'waiting_input')`,
    [tenantId, projectSlug]
  );
  return rows[0]?.n ?? 0;
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
  return {
    continuousActive: true,
    workerSlots: slots,
    enqueued: dispatched.enqueued,
    hint: dispatched.hint,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function pauseContinuousExecution(tenantId, projectSlug) {
  await query(
    `INSERT INTO tenant_execution (tenant_id, project_slug, continuous_active, pause_after_current, updated_at)
     VALUES ($1, $2, false, true, now())
     ON CONFLICT (tenant_id, project_slug) DO UPDATE SET
       continuous_active = false,
       pause_after_current = true,
       updated_at = now()`,
    [tenantId, projectSlug]
  );
  return { pauseAfterCurrent: true };
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
    throw new Error("Execução não está activa. Use start primeiro.");
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
  return {
    continuousActive: true,
    workerSlots: merged,
    enqueued: dispatched.enqueued,
    hint: dispatched.hint,
  };
}

/**
 * Enfileira trabalho automático conforme estado do projeto (simplificado).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function dispatchQueuedWork(tenantId, projectSlug) {
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

  // Reconciliar slots_in_use com jobs realmente activos
  const { rows: activeCount } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND status IN ('running', 'queued')`,
    [tenantId]
  );
  await query(
    `UPDATE tenants SET agent_slots_in_use = $2 WHERE id = $1`,
    [tenantId, activeCount[0]?.n ?? 0]
  );

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
    if (!(await hasActiveJob(tenantId, projectSlug, "provision"))) {
      const id = randomUUID();
      await query(
        `INSERT INTO jobs (id, tenant_id, project_slug, kind, status, payload, requested_by_user_id)
         VALUES ($1, $2, $3, 'provision', 'queued', $4::jsonb, $5)`,
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
            },
          }),
          executorUserId,
        ]
      );
      log.info("Provision automático enfileirado (git não pronto)", { project: projectSlug, jobId: id });
      return { enqueued: [{ jobId: id, kind: "provision" }], hint: null };
    }
    return { enqueued: [], hint: "Aguardando provisionamento Git do projecto." };
  }

  const wave = await getMicroWaveState(tenantId, projectSlug);
  const enqueued = [];
  const macroId = exec.macro_id || projectSlug;

  if (await isLockFree(tenantId, "scope", `${projectSlug}:${macroId}`)) {
    const micros = wave.micros || [];
    if (micros.length === 0) {
      const id = randomUUID();
      await query(
        `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, requested_by_user_id)
         VALUES ($1, $2, $3, 'scope', $4, 'queued', $5)`,
        [id, tenantId, projectSlug, macroId, executorUserId]
      );
      enqueued.push({ jobId: id, kind: "scope" });
      log.info("Job enfileirado (escopo)", { project: projectSlug, jobId: id });
      return { enqueued, hint: null };
    }
  }

  const openId = wave.openMicroId;
  if (openId) {
    const lockKey = `${projectSlug}:${openId}`;
    if (await isLockFree(tenantId, "micro_tasks", lockKey)) {
      const taskCount = wave.taskCountByMicro?.[openId] ?? 0;
      if (taskCount === 0) {
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
        enqueued.push({ jobId: id, kind: "scope-tasks-only" });
        log.info("Job enfileirado (onda tasks)", {
          project: projectSlug,
          microId: openId,
          jobId: id,
        });
        return { enqueued, hint: null };
      }
    }

    const backlog = readBacklogTasks(tenantId, projectSlug);
    const tasksState = readTasksState(tenantId, projectSlug);
    const stateByTaskId = new Map(tasksState.map((t) => [t.id, t]));
    const microTasks = backlog.filter((t) => t.sourceMicroId === openId);

    /** Tasks pausadas (retomáveis com resumeFromStep). */
    const pausedTasks = microTasks.filter((t) => {
      const st = stateByTaskId.get(t.id);
      return st?.status === "paused" && st.lastCompletedStep;
    });

    const TERMINAL_STATUSES = new Set(["done", "blocked", "running", "review", "testing", "development", "planning"]);

    /** A fazer: todo + aprovada + dependências satisfeitas + não concluída/em curso no runtime. */
    const todoTasks = microTasks
      .filter((t) => {
        if (t.status !== "todo" || t.approved !== true) return false;
        if (!taskDependenciesMet(t, backlog, stateByTaskId)) return false;
        const rt = stateByTaskId.get(t.id);
        if (rt && TERMINAL_STATUSES.has(rt.status)) return false;
        return true;
      })
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    const eligible = [...pausedTasks, ...todoTasks];

    if (eligible.length > 0) {
      const activeTasks = await countActiveTaskJobs(tenantId, projectSlug);
      let budget = Math.max(0, slots.length - activeTasks);

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

      return {
        enqueued: [],
        hint:
          "Tasks no A fazer, mas todos os workers estão ocupados. Aguarde conclusão ou adicione slots.",
      };
    }

    /** Micro concluído: todas as tasks done → QA de integração na tech-lead. */
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
      if (!(await hasActiveMicroJob(tenantId, projectSlug, "micro-integration-qa", openId))) {
        const id = randomUUID();
        await query(
          `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, payload, requested_by_user_id)
           VALUES ($1, $2, $3, 'micro-integration-qa', $4, 'queued', $5::jsonb, $6)`,
          [
            id,
            tenantId,
            projectSlug,
            macroId,
            JSON.stringify({ projectSlug, microId: openId }),
            executorUserId,
          ]
        );
        enqueued.push({ jobId: id, kind: "micro-integration-qa", microId: openId });
        log.info("QA de integração do micro", {
          project: projectSlug,
          microId: openId,
          jobId: id,
        });
        return { enqueued, hint: null };
      }
      return {
        enqueued: [],
        hint: `Micro ${openId}: QA de integração em curso.`,
      };
    }

    if (allDone && microTasks.length > 0) {
      return {
        enqueued: [],
        hint: `Micro ${openId}: aguardando merge Tech Lead de todas as PRs em tech-lead.`,
      };
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
