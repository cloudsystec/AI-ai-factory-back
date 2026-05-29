/**
 * Zera completamente o ambiente AI Factory (BD + Redis + volume CLI).
 *
 * Uso:
 *   node scripts/reset-env.js                 # truncate dados, preserva schema
 *   node scripts/reset-env.js --drop          # DROP + recria tudo (migrações de novo)
 *   node scripts/reset-env.js --keep-tenant   # truncate mas preserva tenant + users
 *
 * Após o reset, rode:
 *   npm run db:seed        (recria tenant daniel)
 *   npm run pull-tenant-env -- <tenant-id>
 */
import "dotenv/config";
import { getPool } from "../src/db/pool.js";
import { createClient } from "redis";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACK_ROOT = path.resolve(__dirname, "..");

const drop = process.argv.includes("--drop");
const keepTenant = process.argv.includes("--keep-tenant");

const TABLES_ORDERED = [
  "work_locks",
  "tenant_execution",
  "task_pull_requests",
  "micro_releases",
  "usage_events",
  "project_agent_overrides",
  "project_develop_settings",
  "project_dashboard_snapshots",
  "project_task_details",
  "jobs",
  "projects",
  "agent_templates",
  "tenant_workers",
  "tenant_worker_deployments",
  "stripe_events",
];
const TENANT_TABLES = ["users", "tenants"];

async function flushRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log("  REDIS_URL ausente — skip Redis");
    return;
  }
  try {
    const client = createClient({ url });
    await client.connect();
    await client.flushDb();
    await client.quit();
    console.log("  Redis FLUSHDB OK");
  } catch (e) {
    console.warn("  Redis flush falhou:", e.message);
  }
}

function cleanCliVolume() {
  const tenantDir =
    process.env.TENANT_DATA_DIR ||
    path.resolve(BACK_ROOT, "../ai-factory-cli/data/tenants");
  if (!fs.existsSync(tenantDir)) {
    console.log("  Volume CLI não encontrado:", tenantDir);
    return;
  }
  const entries = fs.readdirSync(tenantDir);
  let cleaned = 0;
  for (const entry of entries) {
    const tenantRoot = path.join(tenantDir, entry);
    if (!fs.statSync(tenantRoot).isDirectory()) continue;
    const workspacesDir = path.join(tenantRoot, "workspaces");
    const scopesDir = path.join(tenantRoot, "scopes");
    const billingDir = path.join(tenantRoot, "billing-sessions");
    for (const dir of [workspacesDir, scopesDir, billingDir]) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        cleaned++;
      }
    }
  }
  console.log(`  Volume CLI: ${cleaned} pastas removidas em ${tenantDir}`);
}

async function main() {
  const pool = getPool();
  console.log("\n=== AI Factory Reset ===\n");

  if (drop) {
    console.log("[1/4] DROP de todas as tabelas + schema_migrations...");
    const allTables = [...TABLES_ORDERED, ...TENANT_TABLES, "schema_migrations"];
    for (const t of allTables) {
      await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`).catch(() => {});
    }
    console.log("  DROP OK — rode npm run db:migrate para recriar\n");
  } else {
    console.log("[1/4] TRUNCATE de tabelas de dados...");
    for (const t of TABLES_ORDERED) {
      await pool
        .query(`TRUNCATE TABLE ${t} CASCADE`)
        .catch(() => console.log(`  (tabela ${t} não existe — ok)`));
    }
    if (!keepTenant) {
      for (const t of TENANT_TABLES) {
        await pool
          .query(`TRUNCATE TABLE ${t} CASCADE`)
          .catch(() => console.log(`  (tabela ${t} não existe — ok)`));
      }
      console.log("  TRUNCATE OK (tudo)\n");
    } else {
      console.log("  TRUNCATE OK (preservou tenants + users)\n");
    }

    console.log("[1b] Reset contadores no tenant...");
    await pool
      .query(
        `UPDATE tenants SET
           agent_slots_in_use = 0,
           has_active_job = false,
           worker_status = 'offline',
           github_installation_id = NULL,
           github_account_login = NULL,
           github_connected_at = NULL,
           updated_at = now()`
      )
      .catch(() => {});
    await pool
      .query(`UPDATE projects SET git_status = 'pending', git_last_error = NULL`)
      .catch(() => {});
  }

  console.log("[2/4] Flush Redis...");
  await flushRedis();

  console.log("[3/4] Limpar workspaces/scopes/billing no volume CLI...");
  cleanCliVolume();

  console.log("[4/4] Resumo\n");
  if (drop) {
    console.log("  BD: schema apagado — rode:");
    console.log("    npm run db:migrate");
    console.log("    npm run db:seed");
  } else if (keepTenant) {
    console.log("  BD: dados limpos (tenant preservado)");
    console.log("  Para recriar o tenant de dev:");
    console.log("    npm run db:seed");
  } else {
    console.log("  BD: dados limpos");
    console.log("  Recriar tenant de dev:");
    console.log("    npm run db:seed");
  }
  console.log("  Depois:");
  console.log("    npm run pull-tenant-env -- a1111111-1111-4111-8111-111111111111");
  console.log("    # Reconectar GitHub no portal");
  console.log("    # Rebuild worker: scripts\\start-tenant-worker.ps1 <id> -Build\n");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
