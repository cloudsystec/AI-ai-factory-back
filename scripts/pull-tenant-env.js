import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { query, getPool } from "../src/db/pool.js";
import { decrypt } from "../src/lib/crypto.js";
import { ensureTenantDirs, tenantDataRoot } from "../src/lib/tenant-paths.js";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("Uso: node scripts/pull-tenant-env.js <tenant-id>");
  process.exit(1);
}

async function main() {
  const { rows } = await query(
    `SELECT id, cursor_admin_api_key_encrypted
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!rows[0]) {
    console.error("Tenant não encontrado");
    process.exit(1);
  }

  ensureTenantDirs(tenantId);
  const dir = tenantDataRoot(tenantId);
  const lines = [
    `TENANT_ID=${tenantId}`,
    `BACK_URL=${process.env.PUBLIC_BACK_URL || "http://host.docker.internal:4000"}`,
    `WORKER_SECRET=${process.env.WORKER_SECRET || ""}`,
    `REDIS_URL=${
      process.env.TENANT_REDIS_URL ||
      process.env.REDIS_URL_DOCKER ||
      "redis://host.docker.internal:6379"
    }`,
    `CURSOR_AGENT_TRUST=${process.env.CURSOR_AGENT_TRUST ?? "1"}`,
  ];

  if (rows[0].cursor_admin_api_key_encrypted) {
    lines.push(
      `CURSOR_ADMIN_API_KEY=${decrypt(rows[0].cursor_admin_api_key_encrypted)}`
    );
  }

  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  console.log("Escrito:", envPath);
  console.log(
    "Nota: CURSOR_API_KEY por executor é enviada no claim de cada job (não no .env)."
  );
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
