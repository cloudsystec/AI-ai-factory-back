import "dotenv/config";
import { getPool } from "../src/db/pool.js";
import { setExecutorCursorApiKey } from "../src/services/user-service.js";

const tenantId = process.argv[2];
const userId = process.argv[3];
const keyArg = process.argv[4];

if (!tenantId || !userId) {
  console.error(
    "Uso: node scripts/set-cursor-key.js <tenant-id> <user-id> [cursor-api-key]"
  );
  console.error("  Grava CURSOR_API_KEY no utilizador executor (não no tenant).");
  process.exit(1);
}

async function main() {
  let key = keyArg?.trim();
  if (!key) {
    console.error("Forneça a cursor-api-key como 4º argumento.");
    process.exit(1);
  }

  await setExecutorCursorApiKey(tenantId, userId, key);
  console.log("CURSOR_API_KEY gravada (encriptada) para executor", userId);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
