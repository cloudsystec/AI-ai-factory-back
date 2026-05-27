import { randomUUID } from "node:crypto";
import { canStartJob, computeCharge } from "../billing/index.js";
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
import { getProjectGitRow } from "./project-git-service.js";

const VALID_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
  "provision",
  "tech-lead-review",
  "micro-integration-qa",
  "micro-release",
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

  if (kind !== "provision") {
    await assertProjectGitReady(tenantId, body.project);
    await assertMicroWaveAllowsJob(tenantId, body.project, {
      kind,
      taskId: body.taskId,
      macroId: body.project,
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
  const requestedBy = EXECUTOR_JOB_KINDS.has(kind)
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

  if (t.agent_slots_in_use >= t.agent_slots_max) {
    throw Object.assign(new Error("Todos os slots ocupados"), { status: 429 });
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
export async function claimJob(tenantId, workerId) {
  const workerSlot = parseWorkerSlot(workerId);
  const client = await (await import("../db/pool.js")).getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: jobs } = await client.query(
      `SELECT j.id, j.project_slug, j.kind, j.macro_id, j.task_id, j.payload,
              j.requested_by_user_id, u.email AS requested_by_email
       FROM jobs j
       LEFT JOIN users u ON u.id = j.requested_by_user_id
       WHERE j.tenant_id = $1 AND j.status = 'queued'
       ORDER BY CASE WHEN j.kind = 'provision' THEN 0 ELSE 1 END, j.created_at ASC
       FOR UPDATE OF j SKIP LOCKED`,
      [tenantId]
    );

    let job = null;
    for (const candidate of jobs) {
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
        const free = await isLockFree(tenantId, lock.lockKind, lock.lockKey);
        if (!free) continue;
      }
      job = candidate;
      break;
    }

    if (!job) {
      await client.query("COMMIT");
      return null;
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
    return job;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Token GitHub installation para jobs no worker (curta duração).
 * @param {string} tenantId
 */
export async function getGitHubTokenForTenant(tenantId) {
  const { rows } = await query(
    `SELECT github_installation_id FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const installationId = rows[0]?.github_installation_id;
  if (!installationId) return null;
  const { getInstallationAccessToken } = await import("./github-app-service.js");
  const { token } = await getInstallationAccessToken(installationId);
  return token;
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
 * @param {{ status: string, costBaseUsd?: number, exitCode?: number }} payload
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
  const billingStatus =
    status === "cancelled" ? "cancelled" : "completed";
  const { cc, fee } = computeCharge(cb, billingStatus);

  const executionId = `exec-${jobId}`;

  const pool = (await import("../db/pool.js")).getPool();
  const client = await pool.connect();
  let projectSlug = null;
  try {
    await client.query("BEGIN");
    const { rows: jobMeta } = await client.query(
      `SELECT j.project_slug, u.email AS executor_email
       FROM jobs j
       LEFT JOIN users u ON u.id = j.requested_by_user_id
       WHERE j.id = $1`,
      [jobId]
    );
    const executorEmail = jobMeta[0]?.executor_email ?? null;
    projectSlug = jobMeta[0]?.project_slug ?? null;

    await client.query(
      `UPDATE jobs SET status = $2, finished_at = now(), exit_code = $3,
       cost_base_usd = $4, charge_usd = $5 WHERE id = $1 AND tenant_id = $6`,
      [jobId, status, payload.exitCode ?? null, cb, cc, tenantId]
    );
    await client.query(
      `INSERT INTO usage_events (
         tenant_id, execution_id, job_id, cost_base_usd, charge_usd, status, executor_email
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (execution_id) DO NOTHING`,
      [tenantId, executionId, jobId, cb, cc, billingStatus, executorEmail]
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

  if (projectSlug) {
    try {
      const { dispatchQueuedWork } = await import(
        "./execution-dispatcher-service.js"
      );
      await dispatchQueuedWork(tenantId, projectSlug);
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
 * @param {{ costBaseUsd: number }} payload
 */
export async function updateJobBilling(tenantId, jobId, payload) {
  const newCb = Number(payload.costBaseUsd) || 0;
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
      `UPDATE jobs SET cost_base_usd = $3, charge_usd = $4, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId, newCb, newCc]
    );
    await client.query(
      `UPDATE usage_events SET cost_base_usd = $2, charge_usd = $3
       WHERE job_id = $1 AND tenant_id = $4`,
      [jobId, newCb, newCc, tenantId]
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
