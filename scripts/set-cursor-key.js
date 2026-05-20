import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import dotenv from "dotenv";
import { getPool } from "../src/db/pool.js";
import { tenantDataRoot } from "../src/lib/tenant-paths.js";
import { setTenantCursorKey } from "../src/services/tenant-service.js";

const tenantId = process.argv[2];
const keyArg = process.argv[3];

if (!tenantId) {
  console.error("Uso: node scripts/set-cursor-key.js <tenant-id> [cursor-api-key]");
  console.error("  Se a key for omitida, lê CURSOR_API_KEY do .env do tenant no CLI.");
  process.exit(1);
}

async function main() {
  let key = keyArg?.trim();
  if (!key) {
    const envPath = path.join(tenantDataRoot(tenantId), ".env");
    if (!fs.existsSync(envPath)) {
      console.error("Sem key na linha de comando e .env do tenant inexistente:", envPath);
      process.exit(1);
    }
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf-8"));
    key = parsed.CURSOR_API_KEY?.trim();
  }
  if (!key) {
    console.error("CURSOR_API_KEY não encontrada.");
    process.exit(1);
  }

  await setTenantCursorKey(tenantId, key);
  console.log("CURSOR_API_KEY gravada (encriptada) para tenant", tenantId);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
