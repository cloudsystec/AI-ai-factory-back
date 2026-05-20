import "dotenv/config";
import { query, getPool } from "../src/db/pool.js";
import { readMacroScopeFromDisk } from "../src/lib/resolve-project-scope.js";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("Uso: node scripts/backfill-scope-md.js <tenant-id>");
  process.exit(1);
}

async function main() {
  const { rows } = await query(
    "SELECT slug, name, scope_md FROM projects WHERE tenant_id = $1",
    [tenantId]
  );
  let updated = 0;
  for (const row of rows) {
    if (String(row.scope_md ?? "").trim()) continue;
    const fromDisk = readMacroScopeFromDisk(tenantId, row.slug);
    if (!fromDisk.scopeMd) {
      console.warn("Sem escopo:", row.slug);
      continue;
    }
    await query(
      "UPDATE projects SET scope_md = $3 WHERE tenant_id = $1 AND slug = $2",
      [tenantId, row.slug, fromDisk.scopeMd]
    );
    console.log("OK:", row.slug);
    updated += 1;
  }
  console.log(`Concluído: ${updated} projeto(s) atualizado(s).`);
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
