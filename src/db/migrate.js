import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { getPool, closePool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../../migrations");

/**
 * @param {{ closePoolAfter?: boolean }} [opts]
 */
export async function runMigrations(opts = {}) {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const { rows } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [file]
    );
    if (rows.length > 0) {
      console.log(`skip ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
      await pool.query("COMMIT");
      console.log(`applied ${file}`);
    } catch (e) {
      await pool.query("ROLLBACK");
      throw e;
    }
  }

  if (opts.closePoolAfter) {
    await closePool();
  }
}

async function main() {
  await runMigrations({ closePoolAfter: true });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.join(__dirname, "migrate.js");

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
