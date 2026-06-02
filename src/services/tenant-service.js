import { query } from "../db/pool.js";
import { decrypt, encrypt } from "../lib/crypto.js";

const PLAN_LIMITS = {
  starter: { pool: 500, slots: 1, users: 5 },
  team: { pool: 1000, slots: 2, users: 10 },
  scale: { pool: 2000, slots: 4, users: 25 },
  business: { pool: 4000, slots: 8, users: 50 },
  enterprise: { pool: 4000, slots: 8, users: 100 },
};

/**
 * @param {string} planId
 */
export function limitsForPlan(planId) {
  return PLAN_LIMITS[planId] || PLAN_LIMITS.starter;
}

/**
 * @param {{ email: string, name?: string, planId?: string, planDays?: number, balanceUsd?: number }} input
 */
export async function upsertTenant(input) {
  const email = String(input.email).trim().toLowerCase();
  const name = String(input.name ?? "").trim();
  const planId = input.planId || "starter";
  const limits = limitsForPlan(planId);
  const days = input.planDays ?? 30;
  const until = new Date();
  until.setDate(until.getDate() + days);
  const balance = input.balanceUsd ?? limits.pool;

  const { rows } = await query(
    `INSERT INTO tenants (
      email, name, plan_id, plan_active_until, balance_usd, pool_credit_cycle_usd,
      agent_slots_max, users_max
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (email) DO UPDATE SET
      name = COALESCE(NULLIF(EXCLUDED.name, ''), tenants.name),
      plan_id = EXCLUDED.plan_id,
      plan_active_until = EXCLUDED.plan_active_until,
      balance_usd = COALESCE(EXCLUDED.balance_usd, tenants.balance_usd),
      pool_credit_cycle_usd = EXCLUDED.pool_credit_cycle_usd,
      agent_slots_max = EXCLUDED.agent_slots_max,
      users_max = EXCLUDED.users_max,
      updated_at = now()
    RETURNING *`,
    [
      email,
      name,
      planId,
      until.toISOString(),
      balance,
      limits.pool,
      limits.slots,
      limits.users,
    ]
  );

  const tenant = rows[0];
  const { ensureWorkerBotRows } = await import("./worker-bot-service.js");
  await ensureWorkerBotRows(tenant.id);
  return tenant;
}

/**
 * @param {string} tenantId
 * @param {string} cursorAdminApiKey
 */
export async function setTenantCursorAdminKey(tenantId, cursorAdminApiKey) {
  const enc = encrypt(cursorAdminApiKey);
  await query(
    "UPDATE tenants SET cursor_admin_api_key_encrypted = $2, updated_at = now() WHERE id = $1",
    [tenantId, enc]
  );
}

/**
 * @param {string} tenantId
 * @returns {Promise<string|null>}
 */
export async function getTenantCursorAdminApiKey(tenantId) {
  const { rows } = await query(
    "SELECT cursor_admin_api_key_encrypted FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (rows[0]?.cursor_admin_api_key_encrypted) {
    return decrypt(rows[0].cursor_admin_api_key_encrypted);
  }
  const platform = String(process.env.PLATFORM_CURSOR_ADMIN_API_KEY || "").trim();
  return platform || null;
}
