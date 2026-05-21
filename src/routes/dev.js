import { Router } from "express";
import { hashPassword } from "../lib/password.js";
import { upsertTenant } from "../services/tenant-service.js";
import { query } from "../db/pool.js";

export const devRouter = Router();

devRouter.use((req, res, next) => {
  if (process.env.ALLOW_DEV_ROUTES !== "true") {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

devRouter.post("/seed-tenant", async (req, res) => {
  const tenant = await upsertTenant({
    email: req.body?.email || "demo@test.com",
    planId: req.body?.planId || "starter",
    planDays: req.body?.planDays ?? 30,
    balanceUsd: req.body?.balanceUsd,
  });
  const email = req.body?.email || tenant.email;
  const password = req.body?.password || "changeme123";
  await query(
    `INSERT INTO users (tenant_id, email, role, password_hash)
     VALUES ($1, $2, 'auditor', $3)
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       role = 'auditor',
       password_hash = EXCLUDED.password_hash`,
    [tenant.id, email, hashPassword(password)]
  );
  res.json({ tenant, email, role: "auditor" });
});
