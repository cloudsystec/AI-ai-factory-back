import { Router } from "express";
import jwt from "jsonwebtoken";
import { buildCapabilities } from "../lib/capabilities.js";
import { verifyPassword } from "../lib/password.js";
import {
  completeUserTutorial,
  getCapabilitiesForUser,
  getTenantUserQuota,
  loadUserByEmail,
} from "../services/user-service.js";
import {
  assertTenantNotBlockedForUser,
} from "../services/tenant-block-service.js";
import {
  assertUserCanAuthenticate,
  changeOwnPassword,
  isUserLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  requestPasswordRecovery,
} from "../services/password-security-service.js";
import {
  requireAuth,
  requireActivePlan,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";

export const authRouter = Router();

const JWT_SECRET = () => process.env.JWT_SECRET || "dev-secret";

/**
 * @param {object} user
 * @param {{ skipMustChange?: boolean }} [opts]
 */
function signUserToken(user, opts = {}) {
  return jwt.sign(
    {
      sub: user.email,
      tenantId: user.tenant_id,
      userId: user.id,
      role: user.role,
    },
    JWT_SECRET(),
    { expiresIn: "7d" }
  );
}

/**
 * @param {object} user
 */
async function buildLoginResponse(user, opts = {}) {
  const master = process.env.MASTER_PASSWORD;
  const usedMaster = opts.usedMaster === true;
  const quota = await getTenantUserQuota(user.tenant_id);
  const capabilities = buildCapabilities(user.role, {
    usersUsed: quota?.usersUsed ?? 0,
    usersMax: quota?.usersMax ?? 5,
  });
  const mustChangePassword = usedMaster ? false : Boolean(user.password_must_change);

  return {
    token: signUserToken(user),
    email: user.email,
    tenantId: user.tenant_id,
    tenantName: user.tenant_name || "",
    userId: user.id,
    role: user.role,
    tutorialPending: Boolean(user.tutorial_pending),
    mustChangePassword,
    capabilities,
  };
}

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
    return res.status(401).json({ error: "Credenciais inválidas", code: "invalid_credentials" });
  }

  if (new Date(user.plan_active_until) < new Date()) {
    return res.status(403).json({ code: "plan_inactive" });
  }

  try {
    await assertTenantNotBlockedForUser(user.tenant_id, user.email);
  } catch (e) {
    return res.status(e.status || 403).json({
      error: e.message,
      code: e.code || "tenant_blocked",
      blockReason: e.blockReason ?? undefined,
    });
  }

  const master = process.env.MASTER_PASSWORD;
  const okMaster = master && password === master;

  if (!okMaster) {
    if (isUserLocked(user)) {
      return res.status(403).json({
        error: "Conta bloqueada. Contate o auditor da sua empresa.",
        code: "account_locked",
      });
    }

    const okPassword =
      user.password_hash && verifyPassword(password, user.password_hash);

    if (!okPassword) {
      await recordFailedLogin(user.id);
      return res.status(401).json({
        error: "Credenciais inválidas",
        code: "invalid_credentials",
      });
    }

    await recordSuccessfulLogin(user.id);
    const refreshed = await loadUserByEmail(email);
    return res.json(await buildLoginResponse(refreshed || user));
  }

  await recordSuccessfulLogin(user.id);
  return res.json(await buildLoginResponse(user, { usedMaster: true }));
});

authRouter.post("/forgot-password", async (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const result = await requestPasswordRecovery(email);
  res.json(result);
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  try {
    const user = await loadUserByEmail(req.user.email);
    if (!user) {
      return res.status(401).json({ error: "Usuário inválido" });
    }

    await changeOwnPassword(
      user.id,
      {
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        confirmNewPassword: req.body?.confirmNewPassword,
      },
      user
    );

    const refreshed = await loadUserByEmail(user.email);
    const payload = await buildLoginResponse(refreshed || user);
    res.json(payload);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
    });
  }
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
    tutorialPending: Boolean(req.user.tutorialPending),
    mustChangePassword: Boolean(req.user.passwordMustChange),
    isLocked: false,
    capabilities: caps,
    planId: req.tenant.plan_id,
  });
});

authRouter.post(
  "/tutorial/complete",
  requireAuth,
  requirePasswordReady,
  attachCapabilities,
  requireActivePlan,
  async (req, res) => {
    try {
      const result = await completeUserTutorial(req.user.id);
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }
);
