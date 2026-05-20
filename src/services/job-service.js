import { randomUUID } from "node:crypto";
import { canStartJob, computeCharge } from "../billing/index.js";
import { query } from "../db/pool.js";

const VALID_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
  "provision",
]);

/**
 * @param {string} tenantId
 * @param {{ kind: string, project: string, taskId?: string, tasksOnly?: boolean }} body
 */
export async function queueJob(tenantId, body) {
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

  const macroId = body.project;
  const id = randomUUID();
  const payload =
    kind === "provision" && body.payload
      ? JSON.stringify(body.payload)
      : null;
  await query(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, task_id, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb)`,
    [
      id,
      tenantId,
      body.project,
      kind,
      macroId,
      body.taskId || null,
      payload,
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
    [id, tenantId, slug, JSON.stringify({ name, slug, scope })]
  );
  return { jobId: id, kind: "provision", slug };
}

/**
 * @param {string} tenantId
 */
export async function claimJob(tenantId, workerId) {
  const client = await (await import("../db/pool.js")).getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: jobs } = await client.query(
      `SELECT id, project_slug, kind, macro_id, task_id, payload
       FROM jobs
       WHERE tenant_id = $1 AND status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [tenantId]
    );
    if (!jobs[0]) {
      await client.query("COMMIT");
      return null;
    }
    const job = jobs[0];
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
      `INSERT INTO tenant_workers (tenant_id, worker_id, last_heartbeat, slots_in_use)
       VALUES ($1, $2, now(), 1)
       ON CONFLICT (tenant_id) DO UPDATE SET
         worker_id = EXCLUDED.worker_id,
         last_heartbeat = now()`,
      [tenantId, workerId]
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
 * @param {string} jobId
 * @param {string} line
 */
export async function appendJobLog(jobId, line) {
  await query(
    "INSERT INTO job_log_lines (job_id, line) VALUES ($1, $2)",
    [jobId, line]
  );
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
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE jobs SET status = $2, finished_at = now(), exit_code = $3,
       cost_base_usd = $4, charge_usd = $5 WHERE id = $1 AND tenant_id = $6`,
      [jobId, status, payload.exitCode ?? null, cb, cc, tenantId]
    );
    await client.query(
      `INSERT INTO usage_events (tenant_id, execution_id, job_id, cost_base_usd, charge_usd, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (execution_id) DO NOTHING`,
      [tenantId, executionId, jobId, cb, cc, billingStatus]
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

  return { cc, fee, cb };
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
 * @param {string} jobId
 */
export async function getJobLogs(jobId) {
  const { rows } = await query(
    "SELECT line FROM job_log_lines WHERE job_id = $1 ORDER BY id ASC",
    [jobId]
  );
  return rows.map((r) => r.line).join("\n");
}

/**
 * @param {string} jobId
 */
export async function getJobById(jobId) {
  const { rows } = await query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  return rows[0] || null;
}
