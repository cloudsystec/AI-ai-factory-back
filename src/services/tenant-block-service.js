import { query } from "../db/pool.js";
import { isPlatformAdminEmail } from "../lib/platform-admin-emails.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tenant-block");

/** @typedef {'security'|'payment'|'other'} TenantBlockReason */

const BLOCK_REASONS = new Set(["security", "payment", "other"]);

/**
 * @param {unknown} row
 */
export function isTenantBlocked(row) {
  return Boolean(row?.blocked_at);
}

/**
 * @param {TenantBlockReason|null|undefined} reason
 */
export function tenantBlockedMessage(reason) {
  if (reason === "payment") {
    return "Empresa bloqueada por falta de pagamento. Contate o suporte da plataforma.";
  }
  if (reason === "security") {
    return "Empresa bloqueada por segurança. Contate o suporte da plataforma.";
  }
  return "Empresa bloqueada. Contate o suporte da plataforma.";
}

/**
 * @param {TenantBlockReason|null|undefined} reason
 */
export function tenantBlockedPayload(reason) {
  return {
    error: tenantBlockedMessage(reason),
    code: "tenant_blocked",
    blockReason: reason || null,
  };
}

/**
 * @param {string} tenantId
 */
export async function getTenantBlockState(tenantId) {
  const { rows } = await query(
    `SELECT id, email, blocked_at, block_reason, block_note, blocked_by
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    tenantId: row.id,
    tenantEmail: row.email,
    blocked: isTenantBlocked(row),
    blockedAt: row.blocked_at,
    blockReason: row.block_reason,
    blockNote: row.block_note,
    blockedBy: row.blocked_by,
  };
}

/**
 * @param {string} tenantId
 * @param {string|null|undefined} userEmail
 */
export async function assertTenantNotBlockedForUser(tenantId, userEmail) {
  if (isPlatformAdminEmail(userEmail)) return null;
  const state = await getTenantBlockState(tenantId);
  if (!state) {
    throw Object.assign(new Error("Tenant não encontrado"), { status: 403, code: "tenant_not_found" });
  }
  if (state.blocked) {
    const err = Object.assign(new Error(tenantBlockedMessage(state.blockReason)), {
      status: 403,
      code: "tenant_blocked",
      blockReason: state.blockReason,
    });
    throw err;
  }
  return state;
}

/**
 * @param {string} tenantId
 */
async function pauseAllTenantProjects(tenantId) {
  const { rows } = await query(
    `SELECT slug FROM projects WHERE tenant_id = $1 ORDER BY slug`,
    [tenantId]
  );
  const { pauseContinuousExecution } = await import("./execution-dispatcher-service.js");
  for (const row of rows) {
    try {
      await pauseContinuousExecution(tenantId, row.slug);
    } catch (e) {
      log.warn("Falha ao pausar projeto no bloqueio", {
        tenantId,
        project: row.slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return rows.length;
}

/**
 * @param {string} tenantId
 * @param {{ reason: string, note?: string, blockedBy: string }} input
 */
export async function blockTenant(tenantId, input) {
  const reason = String(input.reason || "").trim();
  if (!BLOCK_REASONS.has(reason)) {
    throw Object.assign(new Error("Motivo inválido (security, payment ou other)"), {
      status: 400,
    });
  }

  const state = await getTenantBlockState(tenantId);
  if (!state) {
    throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });
  }
  if (isPlatformAdminEmail(state.tenantEmail)) {
    throw Object.assign(
      new Error("Não é possível bloquear o tenant de operação da plataforma"),
      { status: 403, code: "cannot_block_platform_tenant" }
    );
  }
  if (state.blocked) {
    throw Object.assign(new Error("Empresa já está bloqueada"), {
      status: 409,
      code: "tenant_already_blocked",
    });
  }

  const note = String(input.note || "").trim() || null;
  const blockedBy = String(input.blockedBy || "").trim().toLowerCase();

  const { rows } = await query(
    `UPDATE tenants SET
       blocked_at = now(),
       block_reason = $2,
       block_note = $3,
       blocked_by = $4,
       updated_at = now()
     WHERE id = $1
     RETURNING blocked_at, block_reason, block_note, blocked_by`,
    [tenantId, reason, note, blockedBy]
  );

  const pausedProjects = await pauseAllTenantProjects(tenantId);

  const message = tenantBlockedMessage(reason);
  const { broadcast } = await import("../lib/ws-hub.js");
  broadcast(tenantId, { type: "tenant:blocked", reason, message });

  log.info("Tenant bloqueado", { tenantId, reason, blockedBy, pausedProjects });

  return {
    blocked: true,
    blockedAt: rows[0].blocked_at,
    blockReason: rows[0].block_reason,
    blockNote: rows[0].block_note,
    blockedBy: rows[0].blocked_by,
    pausedProjects,
  };
}

/**
 * @param {string} tenantId
 * @param {{ unblockedBy?: string }} [input]
 */
export async function unblockTenant(tenantId, input = {}) {
  const state = await getTenantBlockState(tenantId);
  if (!state) {
    throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });
  }
  if (!state.blocked) {
    throw Object.assign(new Error("Empresa não está bloqueada"), {
      status: 409,
      code: "tenant_not_blocked",
    });
  }

  await query(
    `UPDATE tenants SET
       blocked_at = NULL,
       block_reason = NULL,
       block_note = NULL,
       blocked_by = NULL,
       updated_at = now()
     WHERE id = $1`,
    [tenantId]
  );

  log.info("Tenant desbloqueado", {
    tenantId,
    unblockedBy: input.unblockedBy || null,
  });

  return { blocked: false };
}

export { BLOCK_REASONS };
