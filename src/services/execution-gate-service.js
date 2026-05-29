import { query } from "../db/pool.js";
import { dispatchQueuedWork } from "./execution-dispatcher-service.js";

/**
 * Projectos onde este slot está em Play (continuous, sem pause).
 * @param {string} tenantId
 * @param {number} workerSlot
 * @returns {Promise<Array<{ projectSlug: string, macroId: string }>>}
 */
export async function getActiveExecutionForSlot(tenantId, workerSlot) {
  const slot = Number(workerSlot);
  if (!Number.isInteger(slot) || slot < 1) return [];

  const { rows } = await query(
    `SELECT project_slug, macro_id, selected_worker_slots
     FROM tenant_execution
     WHERE tenant_id = $1 AND continuous_active = true AND pause_after_current = false`,
    [tenantId]
  );

  const out = [];
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
    if (!slots.includes(slot)) continue;
    out.push({
      projectSlug: row.project_slug,
      macroId: row.macro_id || row.project_slug,
    });
  }
  return out;
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 */
export async function dispatchTickForWorker(tenantId, workerSlot) {
  const projects = await getActiveExecutionForSlot(tenantId, workerSlot);
  /** @type {Array<{ project: string, enqueued: object[], hint?: string|null }>} */
  const results = [];
  for (const { projectSlug } of projects) {
    const dispatched = await dispatchQueuedWork(tenantId, projectSlug);
    results.push({
      project: projectSlug,
      enqueued: dispatched.enqueued || [],
      hint: dispatched.hint ?? null,
    });
  }
  return { projects: results };
}
