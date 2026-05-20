import { Router } from "express";
import { upsertTenant, setTenantCursorKey } from "../services/tenant-service.js";
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
    cursorApiKey: req.body?.cursorApiKey,
  });
  if (req.body?.email) {
    await query(
      `INSERT INTO users (tenant_id, email, role) VALUES ($1, $2, 'admin')
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [tenant.id, tenant.email]
    );
  }
  res.json({ tenant });
});

devRouter.post("/tenants/:id/cursor-key", async (req, res) => {
  const key = req.body?.cursorApiKey;
  if (!key) return res.status(400).json({ error: "cursorApiKey obrigatório" });
  await setTenantCursorKey(req.params.id, key);
  res.json({ ok: true });
});
