import pg from "pg";
import { verifyPassword } from "../src/lib/password.js";

const email = "daniel.espindola.l195@gmail.com";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(
  `SELECT id, email, password_hash, password_must_change, failed_login_attempts, locked_at
   FROM users WHERE email = $1`,
  [email]
);
const u = rows[0];
console.log("user:", u || "NOT FOUND");
if (u) {
  console.log({
    mustChange: u.password_must_change,
    attempts: u.failed_login_attempts,
    locked: u.locked_at,
  });
  for (const p of ["2CNCuV_8OPmD6Mau", "2CNCuV_80PmD6Mau"]) {
    console.log(`${p} => ${verifyPassword(p, u.password_hash)}`);
  }
}

for (const p of ["2CNCuV_8OPmD6Mau", "2CNCuV_80PmD6Mau"]) {
  const res = await fetch("http://localhost:4000/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: p }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`login ${p} => ${res.status}`, data.code || data.error || "ok");
}

await pool.end();
