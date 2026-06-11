import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

/** @type {((text: string, params?: unknown[]) => Promise<pg.QueryResult>) | null} */
let queryOverride = null;

export function __setQueryOverrideForTests(fn) {
  queryOverride = fn;
}

export function __resetQueryOverrideForTests() {
  queryOverride = null;
}

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não definido");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function query(text, params) {
  if (queryOverride) return queryOverride(text, params);
  return getPool().query(text, params);
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
