import "dotenv/config";
import { query, getPool } from "../src/db/pool.js";
import { hashPassword } from "../src/lib/password.js";
import { limitsForPlan } from "../src/services/tenant-service.js";
import {
  cloneAgentTemplatesToAllTenantProjects,
  seedAgentTemplatesFromRepo,
} from "../src/services/agent-config-service.js";

/** UUID fixo para smoke tests e scripts */
export const DANIEL_TENANT_ID = "a1111111-1111-4111-8111-111111111111";

const DANIEL_EMAIL = "daniel.espindola.l@hotmail.com";
const DEFAULT_PASSWORD = process.env.SEED_USER_PASSWORD || "changeme123";

async function main() {
  const until = new Date();
  until.setDate(until.getDate() + 30);
  const limits = limitsForPlan("starter");

  await query(
    `INSERT INTO tenants (
      id, email, name, plan_id, plan_active_until, balance_usd, pool_credit_cycle_usd,
      agent_slots_max, users_max, worker_status
    ) VALUES ($1, $2, $3, 'starter', $4, 500, 500, $5, $6, 'offline')
    ON CONFLICT (email) DO UPDATE SET
      name = COALESCE(NULLIF(EXCLUDED.name, ''), tenants.name),
      plan_id = EXCLUDED.plan_id,
      plan_active_until = EXCLUDED.plan_active_until,
      balance_usd = EXCLUDED.balance_usd,
      pool_credit_cycle_usd = EXCLUDED.pool_credit_cycle_usd,
      agent_slots_max = EXCLUDED.agent_slots_max,
      users_max = EXCLUDED.users_max,
      updated_at = now()`,
    [
      DANIEL_TENANT_ID,
      DANIEL_EMAIL,
      "Cloudsys Tec",
      until.toISOString(),
      limits.slots,
      limits.users,
    ]
  );

  const { rows: tenants } = await query(
    "SELECT id FROM tenants WHERE email = $1",
    [DANIEL_EMAIL]
  );
  const tenantId = tenants[0].id;
  const passwordHash = hashPassword(DEFAULT_PASSWORD);

  await query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'auditor', $3)
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       role = 'auditor',
       password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)`,
    [tenantId, DANIEL_EMAIL, passwordHash]
  );

  const templateCount = await seedAgentTemplatesFromRepo();
  await cloneAgentTemplatesToAllTenantProjects(tenantId);

  console.log("Seed OK:", {
    tenantId,
    email: DANIEL_EMAIL,
    role: "auditor",
    plan: "starter",
    usersMax: limits.users,
    seedPassword: DEFAULT_PASSWORD,
    agentTemplates: templateCount,
  });
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
