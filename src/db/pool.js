import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

/** @type {pg.Pool | null} */
let pool = null;

export function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL não definido");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
