import "dotenv/config";
import { query, getPool } from "../src/db/pool.js";
import {
  cloneAgentTemplatesToAllTenantProjects,
  seedAgentTemplatesFromRepo,
} from "../src/services/agent-config-service.js";

/** UUID fixo para smoke tests e scripts */
export const DANIEL_TENANT_ID = "a1111111-1111-4111-8111-111111111111";

const DANIEL_EMAIL = "daniel.espindola.l@hotmail.com";

async function main() {
  const until = new Date();
  until.setDate(until.getDate() + 30);

  await query(
    `INSERT INTO tenants (
      id, email, plan_id, plan_active_until, balance_usd, pool_credit_cycle_usd,
      agent_slots_max, worker_status
    ) VALUES ($1, $2, 'starter', $3, 500, 500, 1, 'offline')
    ON CONFLICT (email) DO UPDATE SET
      plan_id = EXCLUDED.plan_id,
      plan_active_until = EXCLUDED.plan_active_until,
      balance_usd = EXCLUDED.balance_usd,
      pool_credit_cycle_usd = EXCLUDED.pool_credit_cycle_usd,
      agent_slots_max = EXCLUDED.agent_slots_max,
      updated_at = now()`,
    [DANIEL_TENANT_ID, DANIEL_EMAIL, until.toISOString()]
  );

  const { rows: tenants } = await query(
    "SELECT id FROM tenants WHERE email = $1",
    [DANIEL_EMAIL]
  );
  const tenantId = tenants[0].id;

  await query(
    `INSERT INTO users (tenant_id, email, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (tenant_id, email) DO NOTHING`,
    [tenantId, DANIEL_EMAIL]
  );

  const templateCount = await seedAgentTemplatesFromRepo();
  await cloneAgentTemplatesToAllTenantProjects(tenantId);

  console.log("Seed OK:", {
    tenantId,
    email: DANIEL_EMAIL,
    plan: "starter",
    agentTemplates: templateCount,
  });
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
