import "dotenv/config";
import { getPool } from "../src/db/pool.js";
import { writeTenantWorkerEnvFile } from "../src/services/tenant-onboarding-service.js";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("Uso: node scripts/pull-tenant-env.js <tenant-id>");
  process.exit(1);
}

async function main() {
  const { envPath } = await writeTenantWorkerEnvFile(tenantId);
  console.log("Escrito:", envPath);
  console.log(
    "Nota: CURSOR_API_KEY e email do bot vêm no claim de cada job por slot (não no .env)."
  );
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
