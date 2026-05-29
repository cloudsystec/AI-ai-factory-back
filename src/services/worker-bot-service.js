import { query } from "../db/pool.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { parseWorkerSlot } from "./job-service.js";

/**
 * @param {string} tenantId
 */
export async function getTenantSlotsMax(tenantId) {
  const { rows } = await query(
    "SELECT agent_slots_max FROM tenants WHERE id = $1",
    [tenantId]
  );
  return rows[0]?.agent_slots_max ?? 1;
}

/**
 * Garante uma linha por slot 1..agent_slots_max (sem credenciais).
 * @param {string} tenantId
 */
/**
 * Garante que o plano permite pelo menos N slots (ex.: bot #5 configurado).
 * @param {string} tenantId
 * @param {number} minSlot
 */
export async function ensureTenantSlotsMaxAtLeast(tenantId, minSlot) {
  const n = Number(minSlot);
  if (!Number.isInteger(n) || n < 1) return;
  await query(
    `UPDATE tenants SET agent_slots_max = GREATEST(agent_slots_max, $2), updated_at = now()
     WHERE id = $1`,
    [tenantId, n]
  );
}

export async function ensureWorkerBotRows(tenantId) {
  const max = await getTenantSlotsMax(tenantId);
  for (let slot = 1; slot <= max; slot += 1) {
    await query(
      `INSERT INTO tenant_workers (tenant_id, worker_slot, slots_in_use)
       VALUES ($1, $2, 0)
       ON CONFLICT (tenant_id, worker_slot) DO NOTHING`,
      [tenantId, slot]
    );
  }
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 */
export async function isBotReady(tenantId, workerSlot) {
  const { rows } = await query(
    `SELECT cursor_bot_email, cursor_worker_api_key_encrypted
     FROM tenant_workers
     WHERE tenant_id = $1 AND worker_slot = $2`,
    [tenantId, workerSlot]
  );
  const r = rows[0];
  if (!r) return false;
  return Boolean(
    String(r.cursor_bot_email || "").trim() &&
      r.cursor_worker_api_key_encrypted
  );
}

/**
 * @param {string} tenantId
 */
export async function countBotsReady(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM tenant_workers
     WHERE tenant_id = $1
       AND cursor_bot_email IS NOT NULL AND TRIM(cursor_bot_email) <> ''
       AND cursor_worker_api_key_encrypted IS NOT NULL`,
    [tenantId]
  );
  return rows[0]?.n ?? 0;
}

/**
 * @param {string} tenantId
 */
export async function listWorkersStatus(tenantId) {
  await ensureWorkerBotRows(tenantId);
  const max = await getTenantSlotsMax(tenantId);
  const { rows } = await query(
    `SELECT worker_slot, cursor_bot_email,
            cursor_worker_api_key_encrypted IS NOT NULL AS has_worker_api_key,
            last_heartbeat, worker_id
     FROM tenant_workers
     WHERE tenant_id = $1
     ORDER BY worker_slot`,
    [tenantId]
  );
  const bySlot = new Map(rows.map((r) => [r.worker_slot, r]));
  const workers = [];
  for (let slot = 1; slot <= max; slot += 1) {
    const r = bySlot.get(slot);
    const botEmail = r?.cursor_bot_email
      ? String(r.cursor_bot_email).trim()
      : "";
    const botReady = Boolean(
      botEmail && r?.has_worker_api_key
    );
    workers.push({
      slot,
      botEmail: botEmail || null,
      hasWorkerApiKey: Boolean(r?.has_worker_api_key),
      botReady,
      lastHeartbeat: r?.last_heartbeat ?? null,
      workerId: r?.worker_id ?? null,
    });
  }
  return { slotsMax: max, workers };
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 */
export async function getBotConfigForSlot(tenantId, workerSlot) {
  const { rows } = await query(
    `SELECT cursor_bot_email, cursor_worker_api_key_encrypted
     FROM tenant_workers WHERE tenant_id = $1 AND worker_slot = $2`,
    [tenantId, workerSlot]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 * @returns {Promise<string|null>}
 */
export async function getBotWorkerApiKeyDecrypted(tenantId, workerSlot) {
  const row = await getBotConfigForSlot(tenantId, workerSlot);
  if (!row?.cursor_worker_api_key_encrypted) return null;
  return decrypt(row.cursor_worker_api_key_encrypted);
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 * @returns {Promise<string|null>}
 */
export async function getBotEmailForSlot(tenantId, workerSlot) {
  const row = await getBotConfigForSlot(tenantId, workerSlot);
  const email = row?.cursor_bot_email
    ? String(row.cursor_bot_email).trim()
    : "";
  return email || null;
}

/**
 * @param {string} tenantId
 * @param {number} workerSlot
 * @param {{ botEmail?: string, cursorWorkerApiKey?: string }} input
 */
export async function setBotConfigForSlot(tenantId, workerSlot, input) {
  await ensureTenantSlotsMaxAtLeast(tenantId, workerSlot);
  const maxAfter = await getTenantSlotsMax(tenantId);
  if (workerSlot < 1 || workerSlot > maxAfter) {
    throw Object.assign(new Error("worker_slot fora do plano"), { status: 400 });
  }
  await ensureWorkerBotRows(tenantId);

  const email =
    input.botEmail != null
      ? String(input.botEmail).trim().toLowerCase()
      : null;
  const key =
    input.cursorWorkerApiKey != null
      ? String(input.cursorWorkerApiKey).trim()
      : null;

  if (email !== null && !email) {
    throw Object.assign(new Error("botEmail inválido"), { status: 400 });
  }

  const { rows: existing } = await query(
    `SELECT cursor_bot_email, cursor_worker_api_key_encrypted
     FROM tenant_workers WHERE tenant_id = $1 AND worker_slot = $2`,
    [tenantId, workerSlot]
  );
  const prev = existing[0];
  const nextEmail = email !== null ? email : prev?.cursor_bot_email ?? null;
  let nextEnc = prev?.cursor_worker_api_key_encrypted ?? null;
  if (key) {
    nextEnc = encrypt(key);
  }

  await query(
    `INSERT INTO tenant_workers (tenant_id, worker_slot, cursor_bot_email, cursor_worker_api_key_encrypted)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, worker_slot) DO UPDATE SET
       cursor_bot_email = COALESCE(EXCLUDED.cursor_bot_email, tenant_workers.cursor_bot_email),
       cursor_worker_api_key_encrypted = COALESCE(
         EXCLUDED.cursor_worker_api_key_encrypted,
         tenant_workers.cursor_worker_api_key_encrypted
       )`,
    [tenantId, workerSlot, nextEmail, nextEnc]
  );

  return {
    workerSlot,
    botEmail: nextEmail,
    hasWorkerApiKey: Boolean(nextEnc),
    botReady: await isBotReady(tenantId, workerSlot),
  };
}

/**
 * @param {string} tenantId
 * @param {number[]} workerSlots
 */
export async function assertBotsReadyForSlots(tenantId, workerSlots) {
  const slots = [...new Set((workerSlots || []).filter((n) => n >= 1))];
  if (slots.length === 0) {
    throw Object.assign(new Error("Selecione pelo menos um worker."), {
      status: 400,
    });
  }
  for (const slot of slots) {
    if (!(await isBotReady(tenantId, slot))) {
      throw Object.assign(
        new Error(
          `Worker slot ${slot} não configurado. Contacte o administrador da plataforma.`
        ),
        { status: 403, code: "bot_not_configured", workerSlot: slot }
      );
    }
  }
}

/**
 * @param {string} tenantId
 */
export async function assertAtLeastOneBotReady(tenantId) {
  const n = await countBotsReady(tenantId);
  if (n < 1) {
    throw Object.assign(
      new Error(
        "Nenhum bot configurado. Contacte o administrador da plataforma."
      ),
      { status: 403, code: "bot_not_configured" }
    );
  }
}

/**
 * @param {string} workerId
 */
export function workerSlotFromWorkerId(workerId) {
  return parseWorkerSlot(workerId);
}
