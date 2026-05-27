import { Router } from "express";
import jwt from "jsonwebtoken";
import { buildCapabilities } from "../lib/capabilities.js";
import { verifyPassword } from "../lib/password.js";
import {
  getCapabilitiesForUser,
  getTenantUserQuota,
  loadUserByEmail,
} from "../services/user-service.js";
import { requireAuth, requireActivePlan, attachCapabilities } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "")
    .trim()
    .toLowerCase();
  const password = req.body?.password;

  if (!email || typeof password !== "string") {
    return res.status(400).json({ error: "email e password obrigatórios" });
  }

  const user = await loadUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  if (new Date(user.plan_active_until) < new Date()) {
    return res.status(403).json({ code: "plan_inactive" });
  }

  const master = process.env.MASTER_PASSWORD;
  const okMaster = master && password === master;
  const okPassword =
    user.password_hash && verifyPassword(password, user.password_hash);

  if (!okPassword && !okMaster) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const token = jwt.sign(
    {
      sub: user.email,
      tenantId: user.tenant_id,
      userId: user.id,
      role: user.role,
    },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "7d" }
  );

  const quota = await getTenantUserQuota(user.tenant_id);
  const capabilities = buildCapabilities(user.role, {
    usersUsed: quota?.usersUsed ?? 0,
    usersMax: quota?.usersMax ?? 5,
  });

  res.json({
    token,
    email: user.email,
    tenantId: user.tenant_id,
    tenantName: user.tenant_name || "",
    userId: user.id,
    role: user.role,
    capabilities,
  });
});

authRouter.get("/me", requireAuth, attachCapabilities, requireActivePlan, async (req, res) => {
  const caps =
    req.capabilities || (await getCapabilitiesForUser(req.user.id));
  res.json({
    email: req.user.email,
    userId: req.user.id,
    tenantId: req.user.tenantId,
    tenantName: req.user.tenantName || req.tenant.name || "",
    role: req.user.role,
    capabilities: caps,
    planId: req.tenant.plan_id,
  });
});
