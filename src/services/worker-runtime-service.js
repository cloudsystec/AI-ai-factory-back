import { query } from "../db/pool.js";
import { parseWorkerSlot } from "./job-service.js";
import { releaseWorkLocksForJob } from "./work-lock-service.js";
import { dispatchQueuedWork } from "./execution-dispatcher-service.js";
import { log } from "../lib/logger.js";

/**
 * @typedef {{ slot: number, workerId?: string, busy: boolean, jobId?: string|null }} SlotReport
 */

/**
 * Alinha agent_slots_in_use / has_active_job com jobs realmente em execução.
 * @param {string} tenantId
 */
export async function reconcileAgentSlotsInUse(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM jobs
     WHERE tenant_id = $1 AND status IN ('running', 'waiting_input')`,
    [tenantId]
  );
  const n = rows[0]?.n ?? 0;
  await query(
    `UPDATE tenants SET agent_slots_in_use = $2,
       has_active_job = $3,
       worker_status = CASE WHEN $3 THEN 'running' ELSE 'online' END,
       updated_at = now()
     WHERE id = $1`,
    [tenantId, n, n > 0]
  );
  return n;
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 */
async function failOrphanedJob(tenantId, jobId) {
  const { rowCount } = await query(
    `UPDATE jobs SET status = 'failed', finished_at = now(), exit_code = 130
     WHERE id = $1 AND tenant_id = $2 AND status IN ('running', 'waiting_input')`,
    [jobId, tenantId]
  );
  if (rowCount > 0) {
    await releaseWorkLocksForJob(jobId);
  }
  return rowCount > 0;
}

/**
 * Remove slots inactivos do pool de execução (restaura ▶ no front).
 * @param {string} tenantId
 * @param {number[]} idleSlots
 */
async function removeIdleSlotsFromPools(tenantId, idleSlots) {
  const idleSet = new Set(idleSlots.filter((n) => n >= 1));
  if (idleSet.size === 0) return [];

  const { rows } = await query(
    `SELECT project_slug, selected_worker_slots
     FROM tenant_execution WHERE tenant_id = $1`,
    [tenantId]
  );

  /** @type {Array<{ project: string, selectedWorkerSlots: number[], continuousActive: boolean, pauseAfterCurrent: boolean }>} */
  const updates = [];

  for (const row of rows) {
    let slots = row.selected_worker_slots;
    if (typeof slots === "string") {
      try {
        slots = JSON.parse(slots);
      } catch {
        slots = [];
      }
    }
    if (!Array.isArray(slots)) slots = [];
    const next = slots.filter((s) => !idleSet.has(Number(s)));
    if (next.length === slots.length) continue;

    const continuous = next.length > 0;
    await query(
      `UPDATE tenant_execution
       SET selected_worker_slots = $3::jsonb,
           continuous_active = $4,
           pause_after_current = CASE WHEN $4 THEN pause_after_current ELSE true END,
           updated_at = now()
       WHERE tenant_id = $1 AND project_slug = $2`,
      [tenantId, row.project_slug, JSON.stringify(next), continuous]
    );
    updates.push({
      project: row.project_slug,
      selectedWorkerSlots: next,
      continuousActive: continuous,
      pauseAfterCurrent: !continuous,
    });
  }

  return updates;
}

/**
 * @param {import("pg").QueryResultRow} job
 * @param {Map<number, SlotReport>} busyBySlot
 * @param {Set<number>} idleSlots
 */
function shouldFailOrphanedJob(job, { startupAllIdle, busyBySlot, idleSlots }) {
  const slot =
    job.worker_slot != null
      ? Number(job.worker_slot)
      : job.worker_id
        ? parseWorkerSlot(job.worker_id)
        : null;

  if (startupAllIdle) return true;

  if (slot == null || !Number.isFinite(slot)) return false;

  if (idleSlots.has(slot)) return true;

  const report = busyBySlot.get(slot);
  if (report?.busy && report.jobId && report.jobId !== job.id) {
    return true;
  }

  return false;
}

/**
 * CLI é fonte da verdade: reporta slots ocupados; o back corrige jobs e pools desalinhados.
 * @param {string} tenantId
 * @param {{ slots?: SlotReport[], startup?: boolean }} input
 */
export async function syncWorkerRuntime(tenantId, input = {}) {
  const reports = Array.isArray(input.slots) ? input.slots : [];
  const startup = input.startup === true;

  const idleSlots = new Set(
    reports.filter((s) => Number(s.slot) >= 1 && !s.busy).map((s) => Number(s.slot))
  );
  /** @type {Map<number, SlotReport>} */
  const busyBySlot = new Map(
    reports
      .filter((s) => s.busy && Number(s.slot) >= 1)
      .map((s) => [Number(s.slot), s])
  );

  const startupAllIdle =
    startup && (reports.length === 0 || reports.every((s) => !s.busy));

  for (const r of reports) {
    const slot = Number(r.slot);
    if (!Number.isInteger(slot) || slot < 1) continue;
    const workerId =
      r.workerId || `cli-${String(tenantId).slice(0, 8)}-slot-${slot}`;
    await query(
      `INSERT INTO tenant_workers (tenant_id, worker_slot, worker_id, last_heartbeat, slots_in_use)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (tenant_id, worker_slot) DO UPDATE SET
         worker_id = EXCLUDED.worker_id,
         last_heartbeat = now(),
         slots_in_use = EXCLUDED.slots_in_use`,
      [tenantId, slot, workerId, r.busy ? 1 : 0]
    );
  }

  await query(
    `UPDATE tenants SET worker_status = 'online', updated_at = now() WHERE id = $1`,
    [tenantId]
  );

  const { rows: activeJobs } = await query(
    `SELECT j.id, j.project_slug, j.status, j.worker_id,
            COALESCE(
              wl.worker_slot,
              CASE WHEN j.worker_id ~ 'slot-[0-9]+$'
                THEN (regexp_match(j.worker_id, 'slot-([0-9]+)$'))[1]::int
                ELSE NULL END
            ) AS worker_slot
     FROM jobs j
     LEFT JOIN work_locks wl ON wl.job_id = j.id AND wl.tenant_id = j.tenant_id
     WHERE j.tenant_id = $1 AND j.status IN ('running', 'waiting_input')`,
    [tenantId]
  );

  /** @type {Array<{ jobId: string, project: string, slot: number|null }>} */
  const failed = [];
  const projectsToDispatch = new Set();

  for (const job of activeJobs) {
    if (
      !shouldFailOrphanedJob(job, { startupAllIdle, busyBySlot, idleSlots })
    ) {
      continue;
    }
    const ok = await failOrphanedJob(tenantId, job.id);
    if (ok) {
      failed.push({
        jobId: job.id,
        project: job.project_slug,
        slot: job.worker_slot != null ? Number(job.worker_slot) : null,
      });
      projectsToDispatch.add(job.project_slug);
      log.info("Job órfão reconciliado (runtime CLI)", {
        tenant: String(tenantId).slice(0, 8),
        jobId: job.id,
        slot: job.worker_slot,
        startup: startupAllIdle,
      });
    }
  }

  const slotsInUse = await reconcileAgentSlotsInUse(tenantId);

  /** @type {Awaited<ReturnType<typeof removeIdleSlotsFromPools>>} */
  let executionUpdates = [];
  if (startup && idleSlots.size > 0) {
    executionUpdates = await removeIdleSlotsFromPools(tenantId, [...idleSlots]);
    for (const u of executionUpdates) {
      projectsToDispatch.add(u.project);
    }
  }

  const dispatched = [];
  for (const projectSlug of projectsToDispatch) {
    try {
      const d = await dispatchQueuedWork(tenantId, projectSlug);
      if (d.enqueued?.length) {
        dispatched.push({ project: projectSlug, enqueued: d.enqueued });
      }
    } catch (e) {
      log.warn("Dispatch após runtime-sync", {
        project: projectSlug,
        error: e.message,
      });
    }
  }

  return {
    ok: true,
    failed,
    executionUpdates,
    slotsInUse,
    dispatched,
    startupAllIdle,
  };
}
