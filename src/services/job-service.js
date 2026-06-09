import { randomUUID } from "node:crypto";
import { canStartJob, computeCharge } from "../billing/index.js";
import {
  normalizeChargeSource,
  resolveJobChargeSource,
} from "../lib/charge-source.js";
import { query } from "../db/pool.js";
import {
  appendJobLogLine,
  readJobLogFull,
  setJobLogExpiry,
} from "../lib/job-log-redis.js";
import { assertProjectGitReady } from "./project-git-service.js";
import { assertMicroWaveAllowsJob } from "./micro-wave-service.js";
import {
  resolveLockForJob,
  isLockFree,
  acquireWorkLock,
  releaseWorkLocksForJob,
} from "./work-lock-service.js";
import { getInstallationOctokit } from "./github-app-service.js";
import { getProjectGitRow, getProjectInstallationId } from "./project-git-service.js";

const VALID_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
  "provision",
  "tech-lead-review",
  "micro-integration-qa",
  "micro-release",
  "git-migrate",
  "railway-publish",
]);

const EXECUTOR_JOB_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
]);

/**
 * @param {string} workerId
 */
export function parseWorkerSlot(workerId) {
  const m = String(workerId || "").match(/slot-(\d+)$/i);
  return m ? Number(m[1]) : 1;
}

/** Prioridade menor = claim primeiro (tasks paralelas em Play contínuo). */
const CLAIM_KIND_PRIORITY = {
  task: 0,
  "scope-tasks-only": 10,
  develop: 20,
  scope: 30,
  provision: 40,
  "tech-lead-review": 50,
  "micro-integration-qa": 60,
  "micro-release": 70,
  "git-migrate": 35,
  "railway-publish": 38,
};

/**
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 */
async function loadContinuousProjects(client, tenantId) {
  const { rows } = await client.query(
    `SELECT project_slug, selected_worker_slots
     FROM tenant_execution
     WHERE tenant_id = $1 AND continuous_active = true`,
    [tenantId]
  );
  const map = new Map();
  for (const row of rows) {
    const slots = Array.isArray(row.selected_worker_slots)
      ? row.selected_worker_slots
      : JSON.parse(row.selected_worker_slots || "[]");
    map.set(row.project_slug, slots);
  }
  return map;
}

/**
 * @param {object} candidate
 * @param {Map<string, number[]>} continuousByProject
 */
function claimPriority(candidate, continuousByProject) {
  const base = CLAIM_KIND_PRIORITY[candidate.kind] ?? 50;
  const slots = continuousByProject.get(candidate.project_slug);
  if (!slots?.length) return base + 100;
  if (candidate.kind === "task") return base;
  return base + 5;
}

/**
 * @param {string} tenantId
 * @param {{ kind: string, project: string, taskId?: string, tasksOnly?: boolean }} body
 * @param {{ requestedByUserId?: string }} [opts]
 */
export async function queueJob(tenantId, body, opts = {}) {
  let kind = body.kind;
  if (kind === "scope" && body.tasksOnly) kind = "scope-tasks-only";
  if (!VALID_KINDS.has(kind)) {
    throw Object.assign(new Error("kind inválido"), { status: 400 });
  }

  const { rows: tenants } = await query(
    `SELECT balance_usd, has_active_job, agent_slots_max, agent_slots_in_use
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const t = tenants[0];
  if (!t) throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });

  const check = canStartJob(Number(t.balance_usd), t.has_active_job);
  if (!check.allowed) {
    throw Object.assign(
      new Error("Saldo insuficiente para nova execução"),
      { status: 402, code: check.reason }
    );
  }

  if (t.agent_slots_in_use >= t.agent_slots_max) {
    throw Object.assign(new Error("Todos os slots ocupados"), { status: 429 });
  }

  if (kind !== "provision" && kind !== "railway-publish") {
    const { assertProjectNotCompleted } = await import(
      "./project-completion-service.js"
    );
    await assertProjectNotCompleted(tenantId, body.project);
    await assertProjectGitReady(tenantId, body.project);
    await assertMicroWaveAllowsJob(tenantId, body.project, {
      kind,
      taskId: body.taskId,
      macroId: body.project,
      microId: body.microId || null,
    });
  }

  const macroId = body.project;
  const id = randomUUID();
  let payloadObj = body.payload || null;
  if (kind === "scope-tasks-only" && body.microId) {
    payloadObj = { ...(payloadObj || {}), microId: body.microId };
  }
  const retryStep = body.retryFromStep || body.resumeFromStep;
  if (retryStep && kind === "task") {
    payloadObj = { ...(payloadObj || {}), retryFromStep: retryStep };
  }
  if (body.retryMode && kind === "task") {
    payloadObj = { ...(payloadObj || {}), retryMode: body.retryMode };
  }
  if (body.failedStep && kind === "task") {
    payloadObj = { ...(payloadObj || {}), failedStep: body.failedStep };
  }
  const payload =
    payloadObj != null ? JSON.stringify(payloadObj) : null;
  const requestedBy = EXECUTOR_JOB_KINDS.has(kind) || kind === "railway-publish"
    ? opts.requestedByUserId || null
    : null;
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, task_id, status, payload, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8)`,
    [
      id,
      tenantId,
      body.project,
      kind,
      macroId,
      body.taskId || null,
      payload,
      requestedBy,
    ]
  );

  return { jobId: id, kind, macroId };
}

/**
 * Enfileira provisionamento de workspace no CLI (sem macro_id de pipeline).
 * @param {string} tenantId
 * @param {{ slug: string, name: string, scope: string }} input
 */
export async function queueProvisionJob(tenantId, input) {
  const slug = String(input.slug ?? "").trim();
  const name = String(input.name ?? "").trim();
  const scope = String(input.scope ?? "").trim();
  const git = input.git || null;
  if (!slug || !name || !scope) {
    throw Object.assign(new Error("name, slug e scope obrigatórios"), {
      status: 400,
    });
  }

  const { rows: tenants } = await query(
    `SELECT balance_usd, has_active_job, agent_slots_max, agent_slots_in_use
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const t = tenants[0];
  if (!t) throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });

  const check = canStartJob(Number(t.balance_usd), t.has_active_job);
  if (!check.allowed) {
    throw Object.assign(
      new Error("Saldo insuficiente para nova execução"),
      { status: 402, code: check.reason }
    );
  }

  const id = randomUUID();
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, status, payload)
     VALUES ($1, $2, $3, 'provision', 'queued', $4::jsonb)`,
    [
      id,
      tenantId,
      slug,
      JSON.stringify({ name, slug, scope, git }),
    ]
  );
  return { jobId: id, kind: "provision", slug };
}

/**
 * @param {string} tenantId
 */
/**
 * @param {string} tenantId
 * @param {string} workerId
 * @param {{ provisionOnly?: boolean }} [opts]
 */
async function hasQueuedInfraJobWithoutBot(tenantId) {
  const { rows } = await query(
    `SELECT kind FROM jobs
     WHERE tenant_id = $1 AND status = 'queued'
       AND kind IN ('provision', 'git-migrate', 'railway-publish')
     LIMIT 1`,
    [tenantId]
  );
  if (!rows[0]) return false;
  if (rows[0].kind === "railway-publish") {
    return Boolean(
      String(process.env.PLATFORM_CURSOR_ADMIN_API_KEY || "").trim()
    );
  }
  return true;
}

/**
 * Job id para registar billing de infra (ex.: railway-publish) no projecto —
 * ancora no último job do slot 1 no mesmo projecto, senão o job infra actual.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} fallbackJobId
 */
export async function resolveBillingJobIdForProjectSlot1(
  tenantId,
  projectSlug,
  fallbackJobId
) {
  const { rows } = await query(
    `SELECT j.id
     FROM jobs j
     INNER JOIN work_locks wl
       ON wl.job_id = j.id AND wl.tenant_id = j.tenant_id
     WHERE j.tenant_id = $1
       AND j.project_slug = $2
       AND wl.worker_slot = 1
       AND j.kind NOT IN ('provision', 'git-migrate', 'railway-publish')
     ORDER BY
       CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
       j.started_at DESC NULLS LAST,
       j.created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  return rows[0]?.id || fallbackJobId;
}

export async function claimJob(tenantId, workerId, opts = {}) {
  const provisionOnly = opts.provisionOnly === true;
  const workerSlot = parseWorkerSlot(workerId);
  const { isBotReady } = await import("./worker-bot-service.js");
  const botReady = await isBotReady(tenantId, workerSlot);
  if (!botReady && !(await hasQueuedInfraJobWithoutBot(tenantId))) {
    return { job: null, error: "bot_not_configured", workerSlot };
  }

  const { getActiveExecutionForSlot } = await import(
    "./execution-gate-service.js"
  );
  const activeProjects = await getActiveExecutionForSlot(tenantId, workerSlot);
  const activeProjectSet = new Set(
    activeProjects.map((p) => p.projectSlug)
  );
  if (!provisionOnly && activeProjectSet.size === 0) {
    const { rows: infraQueued } = await query(
      `SELECT 1 FROM jobs
       WHERE tenant_id = $1 AND status = 'queued'
         AND kind IN ('provision', 'git-migrate', 'railway-publish')
       LIMIT 1`,
      [tenantId]
    );
    if (!infraQueued[0]) {
      return { job: null, workerSlot };
    }
  }

  const client = await (await import("../db/pool.js")).getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: tenantRows } = await client.query(
      `SELECT agent_slots_max, agent_slots_in_use FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId]
    );
    const tenantRow = tenantRows[0];
    if (
      tenantRow &&
      Number(tenantRow.agent_slots_in_use) >= Number(tenantRow.agent_slots_max)
    ) {
      await client.query("COMMIT");
      return { job: null, workerSlot };
    }

    const continuousByProject = await loadContinuousProjects(client, tenantId);

    const { rows: jobs } = await client.query(
      `SELECT j.id, j.project_slug, j.kind, j.macro_id, j.task_id, j.payload,
              j.requested_by_user_id, u.email AS requested_by_email, j.created_at
       FROM jobs j
       LEFT JOIN users u ON u.id = j.requested_by_user_id
       WHERE j.tenant_id = $1 AND j.status = 'queued'
       FOR UPDATE OF j SKIP LOCKED`,
      [tenantId]
    );

    const sorted = [...jobs].sort((a, b) => {
      const pa = claimPriority(a, continuousByProject);
      const pb = claimPriority(b, continuousByProject);
      if (pa !== pb) return pa - pb;
      return new Date(a.created_at) - new Date(b.created_at);
    });

    const queuedTaskByProject = new Set(
      sorted
        .filter((j) => j.kind === "task" && continuousByProject.has(j.project_slug))
        .map((j) => j.project_slug)
    );

    let job = null;
    for (const candidate of sorted) {
      if (
        !botReady &&
        !["provision", "git-migrate", "railway-publish"].includes(candidate.kind)
      ) {
        continue;
      }
      if (
        provisionOnly &&
        !["provision", "git-migrate", "railway-publish"].includes(candidate.kind)
      ) {
        continue;
      }
      if (candidate.kind === "provision" || candidate.kind === "git-migrate" || candidate.kind === "railway-publish") {
        /* Infra Git / publicação — corre sem Play activo */
      } else if (!activeProjectSet.has(candidate.project_slug)) {
        continue;
      }
      if (
        queuedTaskByProject.has(candidate.project_slug) &&
        candidate.kind !== "task"
      ) {
        continue;
      }
      if (
        candidate.kind === "scope-tasks-only" &&
        queuedTaskByProject.has(candidate.project_slug)
      ) {
        continue;
      }
      const payload =
        typeof candidate.payload === "string"
          ? JSON.parse(candidate.payload)
          : candidate.payload || {};
      const lock = resolveLockForJob(
        candidate.kind,
        candidate.project_slug,
        candidate.task_id,
        candidate.macro_id,
        payload
      );
      if (lock) {
        const free = await isLockFree(
          tenantId,
          lock.lockKind,
          lock.lockKey,
          client
        );
        if (!free) continue;
      }
      job = candidate;
      break;
    }

    if (!job) {
      await client.query("COMMIT");
      return { job: null, workerSlot };
    }

    const payload =
      typeof job.payload === "string"
        ? JSON.parse(job.payload)
        : job.payload || {};
    const lock = resolveLockForJob(
      job.kind,
      job.project_slug,
      job.task_id,
      job.macro_id,
      payload
    );
    if (lock) {
      await acquireWorkLock(
        client,
        tenantId,
        job.project_slug,
        lock.lockKind,
        lock.lockKey,
        job.id,
        workerSlot
      );
    }

    await client.query(
      `UPDATE jobs SET status = 'running', worker_id = $2, started_at = now() WHERE id = $1`,
      [job.id, workerId]
    );
    await client.query(
      `UPDATE tenants SET agent_slots_in_use = agent_slots_in_use + 1,
       has_active_job = true, worker_status = 'running', updated_at = now()
       WHERE id = $1`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO tenant_workers (tenant_id, worker_id, worker_slot, last_heartbeat, slots_in_use)
       VALUES ($1, $2, $3, now(), 1)
       ON CONFLICT (tenant_id, worker_slot) DO UPDATE SET
         worker_id = EXCLUDED.worker_id,
         last_heartbeat = now()`,
      [tenantId, workerId, workerSlot]
    );
    await client.query("COMMIT");
    return { job, workerSlot };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Token GitHub installation para jobs no worker (curta duração).
 * Preferência: installation do projecto; fallback tenant.
 * @param {string} tenantId
 * @param {string} [projectSlug]
 */
export async function getGitHubTokenForProject(tenantId, projectSlug) {
  let installationId = null;
  if (projectSlug) {
    installationId = await getProjectInstallationId(tenantId, projectSlug);
  }
  if (!installationId) {
    const { rows } = await query(
      `SELECT github_installation_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    installationId = rows[0]?.github_installation_id;
  }
  if (!installationId) return null;
  const { getInstallationAccessToken } = await import("./github-app-service.js");
  const { token } = await getInstallationAccessToken(installationId);
  return token;
}

/**
 * @param {string} tenantId
 */
export async function getGitHubTokenForTenant(tenantId) {
  return getGitHubTokenForProject(tenantId);
}

/**
 * @param {string} jobId
 * @param {string} line
 */
export async function appendJobLog(jobId, line) {
  await appendJobLogLine(jobId, line);
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 * @param {{ status: string, costBaseUsd?: number, exitCode?: number, chargeSource?: string }} payload
 */
export async function completeJob(tenantId, jobId, payload) {
  const status =
    payload.status === "cancelled"
      ? "cancelled"
      : payload.status === "failed"
        ? "failed"
        : "succeeded";

  const cb =
    payload.costBaseUsd ??
    Number(process.env.BILLING_CB_ESTIMATE_USD || 0.5);
  const chargeSource = resolveJobChargeSource(payload);
  const billingStatus =
    status === "cancelled" ? "cancelled" : "completed";
  const { cc, fee } = computeCharge(cb, billingStatus);

  const executionId = `exec-${jobId}`;

  const pool = (await import("../db/pool.js")).getPool();
  const client = await pool.connect();
  let projectSlug = null;
  let jobKind = null;
  try {
    await client.query("BEGIN");
    const { rows: jobMeta } = await client.query(
      `SELECT j.project_slug, j.kind, u.email AS executor_email,
              wl.worker_slot,
              tw.cursor_bot_email AS bot_email
       FROM jobs j
       LEFT JOIN users u ON u.id = j.requested_by_user_id
       LEFT JOIN work_locks wl ON wl.job_id = j.id AND wl.tenant_id = j.tenant_id
       LEFT JOIN tenant_workers tw
         ON tw.tenant_id = j.tenant_id AND tw.worker_slot = wl.worker_slot
       WHERE j.id = $1`,
      [jobId]
    );
    const executorEmail = jobMeta[0]?.executor_email ?? null;
    const botEmail = jobMeta[0]?.bot_email
      ? String(jobMeta[0].bot_email).trim()
      : null;
    const workerSlot = jobMeta[0]?.worker_slot ?? null;
    projectSlug = jobMeta[0]?.project_slug ?? null;
    jobKind = jobMeta[0]?.kind ?? null;

    await client.query(
      `UPDATE jobs SET status = $2, finished_at = now(), exit_code = $3,
       cost_base_usd = $4, charge_usd = $5, charge_source = $7
       WHERE id = $1 AND tenant_id = $6`,
      [jobId, status, payload.exitCode ?? null, cb, cc, tenantId, chargeSource]
    );
    await client.query(
      `INSERT INTO usage_events (
         tenant_id, execution_id, job_id, cost_base_usd, charge_usd, status,
         executor_email, bot_email, worker_slot, charge_source
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (execution_id) DO NOTHING`,
      [
        tenantId,
        executionId,
        jobId,
        cb,
        cc,
        billingStatus,
        executorEmail,
        botEmail,
        workerSlot,
        chargeSource,
      ]
    );
    await client.query(
      `UPDATE tenants SET balance_usd = balance_usd - $2,
       agent_slots_in_use = GREATEST(0, agent_slots_in_use - 1),
       has_active_job = (SELECT EXISTS(
         SELECT 1 FROM jobs WHERE tenant_id = $1 AND status IN ('running','waiting_input')
       )),
       updated_at = now()
       WHERE id = $1`,
      [tenantId, cc]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await releaseWorkLocksForJob(jobId);

  if (jobKind === "railway-publish" && status === "failed" && projectSlug) {
    try {
      const { upsertRailwayDeployment } = await import(
        "./project-railway-service.js"
      );
      await upsertRailwayDeployment(tenantId, projectSlug, {
        status: "failed",
        last_error:
          "Não foi possível publicar a aplicação automaticamente. Tente novamente.",
      });
      const { broadcast } = await import("../lib/ws-hub.js");
      broadcast(tenantId, {
        type: "dashboard",
        project: projectSlug,
        reason: "railway-publish",
      });
    } catch {
      /* ignore */
    }
  }

  try {
    const { reconcileTenantSlotsInUse } = await import(
      "./execution-dispatcher-service.js"
    );
    await reconcileTenantSlotsInUse(tenantId);
  } catch {
    /* ignore */
  }

  if (projectSlug) {
    try {
      const { dispatchQueuedWork } = await import(
        "./execution-dispatcher-service.js"
      );
      const dispatched = await dispatchQueuedWork(tenantId, projectSlug);
      if (dispatched.enqueued?.length) {
        const { broadcastWorkersAndJobs } = await import("../lib/ws-hub.js");
        broadcastWorkersAndJobs(tenantId, projectSlug, dispatched.enqueued);
      } else {
        const { broadcast } = await import("../lib/ws-hub.js");
        broadcast(tenantId, { type: "billing" });
      }
    } catch (e) {
      const { log } = await import("../lib/logger.js");
      log.warn("Dispatch após job", { error: e.message });
    }
  }

  try {
    await setJobLogExpiry(jobId);
  } catch (e) {
    const { log } = await import("../lib/logger.js");
    log.warn("setJobLogExpiry", { error: e.message });
  }

  return { cc, fee, cb };
}

/**
 * Atualiza apenas o custo de um job já completado, ajustando
 * o balance do tenant pela diferença (novo - antigo).
 * @param {string} tenantId
 * @param {string} jobId
 * @param {{ costBaseUsd: number, chargeSource?: string }} payload
 */
export async function updateJobBilling(tenantId, jobId, payload) {
  const newCb = Number(payload.costBaseUsd) || 0;
  const chargeSource = normalizeChargeSource(
    payload.chargeSource || "cursor_admin_api"
  );
  const pool = (await import("../db/pool.js")).getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT cost_base_usd, charge_usd, status FROM jobs
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId]
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const oldCb = Number(rows[0].cost_base_usd) || 0;
    const oldCc = Number(rows[0].charge_usd) || 0;
    const billingStatus =
      rows[0].status === "cancelled" ? "cancelled" : "completed";
    const { cc: newCc } = computeCharge(newCb, billingStatus);
    const chargeDelta = newCc - oldCc;

    await client.query(
      `UPDATE jobs SET cost_base_usd = $3, charge_usd = $4, charge_source = $5, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId, newCb, newCc, chargeSource]
    );
    await client.query(
      `UPDATE usage_events SET cost_base_usd = $2, charge_usd = $3, charge_source = $4
       WHERE job_id = $1 AND tenant_id = $5`,
      [jobId, newCb, newCc, chargeSource, tenantId]
    );
    if (chargeDelta !== 0) {
      await client.query(
        `UPDATE tenants SET balance_usd = balance_usd - $2, updated_at = now()
         WHERE id = $1`,
        [tenantId, chargeDelta]
      );
    }
    await client.query("COMMIT");
    return { oldCb, newCb, oldCc, newCc, chargeDelta };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {string} tenantId
 */
export async function getActiveJobForTenant(tenantId) {
  const { rows } = await query(
    `SELECT id, project_slug, kind, status, started_at
     FROM jobs WHERE tenant_id = $1 AND status IN ('running','waiting_input','queued')
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * Jobs ativos do tenant (um por slot em uso), ordenados por início.
 * @param {string} tenantId
 */
export async function listActiveJobsForTenant(tenantId) {
  const { rows } = await query(
    `SELECT j.id, j.project_slug, j.kind, j.status, j.task_id, j.started_at, j.macro_id,
            u.email AS executor_email, wl.worker_slot
     FROM jobs j
     LEFT JOIN users u ON u.id = j.requested_by_user_id
     LEFT JOIN work_locks wl ON wl.job_id = j.id AND wl.tenant_id = j.tenant_id
     WHERE j.tenant_id = $1 AND j.status IN ('running', 'waiting_input', 'queued')
     ORDER BY j.started_at ASC NULLS LAST, j.created_at ASC`,
    [tenantId]
  );
  return rows;
}

/**
 * Job ativo do projeto ou, se não houver, o mais recente (qualquer estado).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getLatestJobForProject(tenantId, projectSlug) {
  const { rows: active } = await query(
    `SELECT id, project_slug, kind, status, started_at, finished_at
     FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2
       AND status IN ('running', 'waiting_input', 'queued')
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  if (active[0]) return active[0];

  const { rows } = await query(
    `SELECT id, project_slug, kind, status, started_at, finished_at
     FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug]
  );
  return rows[0] || null;
}

const JOB_SLOT_SELECT = `
  SELECT j.id, j.project_slug, j.kind, j.status, j.task_id, j.started_at,
         j.finished_at, j.macro_id, j.exit_code, j.worker_id, j.created_at,
         COALESCE(
           wl.worker_slot,
           CASE WHEN j.worker_id ~ 'slot-[0-9]+$'
             THEN (regexp_match(j.worker_id, 'slot-([0-9]+)$'))[1]::int
             ELSE NULL END
         ) AS worker_slot
  FROM jobs j
  LEFT JOIN work_locks wl ON wl.job_id = j.id AND wl.tenant_id = j.tenant_id`;

const JOB_SLOT_WHERE = `
  j.tenant_id = $1 AND j.project_slug = $2
  AND (
    wl.worker_slot = $3
    OR j.worker_id ~ ('slot-' || $3::text || '$')
  )`;

/**
 * Job activo ou mais recente de um bot (slot) no projecto.
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {number} workerSlot
 */
export async function getJobForWorkerSlot(tenantId, projectSlug, workerSlot) {
  const slot = Number(workerSlot);
  if (!Number.isInteger(slot) || slot < 1) return null;

  const { rows: active } = await query(
    `${JOB_SLOT_SELECT}
     WHERE ${JOB_SLOT_WHERE}
       AND j.status IN ('running', 'waiting_input', 'queued')
     ORDER BY j.started_at DESC NULLS LAST, j.created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug, slot]
  );
  if (active[0]) return active[0];

  const { rows } = await query(
    `${JOB_SLOT_SELECT}
     WHERE ${JOB_SLOT_WHERE}
     ORDER BY j.created_at DESC
     LIMIT 1`,
    [tenantId, projectSlug, slot]
  );
  return rows[0] || null;
}

/**
 * @param {string} jobId
 */
export async function getJobLogs(jobId) {
  return readJobLogFull(jobId);
}

/**
 * @param {string} jobId
 */
export async function getJobById(jobId) {
  const { rows } = await query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  return rows[0] || null;
}
