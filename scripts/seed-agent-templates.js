import "dotenv/config";
import { getPool } from "../src/db/pool.js";
import { seedAgentTemplatesFromRepo } from "../src/services/agent-config-service.js";

async function main() {
  const n = await seedAgentTemplatesFromRepo();
  console.log(`Agent templates seed: ${n} roles (novos ignorados se já existiam)`);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
