import { Router } from "express";
import { requireAuth, requireActivePlan, requirePasswordReady } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  createTenantUser,
  deleteTenantUser,
  getUserInTenant,
  listTenantUsers,
  updateTenantUserRole,
} from "../services/user-service.js";
import {
  resetTemporaryPasswordForUser,
  unlockUser,
} from "../services/password-security-service.js";
import { isPlatformAdminEmail } from "../lib/platform-admin-emails.js";

export const tenantUsersRouter = Router();
tenantUsersRouter.use(requireAuth, requirePasswordReady, requireActivePlan, requireCapability("manageUsers"));

const AUDITOR_CREATABLE = new Set(["executor", "viewer"]);

tenantUsersRouter.get("/", async (req, res) => {
  try {
    res.json(await listTenantUsers(req.user.tenantId));
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
      usersUsed: e.usersUsed,
      usersMax: e.usersMax,
    });
  }
});

tenantUsersRouter.post("/", async (req, res) => {
  try {
    const user = await createTenantUser(
      req.user.tenantId,
      {
        email: req.body?.email,
        role: req.body?.role,
      },
      { allowedRoles: AUDITOR_CREATABLE, tenantName: req.user.tenantName }
    );
    res.status(201).json({ user });
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
      usersUsed: e.usersUsed,
      usersMax: e.usersMax,
    });
  }
});

tenantUsersRouter.patch("/:id", async (req, res) => {
  try {
    const user = await updateTenantUserRole(
      req.user.tenantId,
      req.params.id,
      { role: req.body?.role },
      { allowedRoles: AUDITOR_CREATABLE }
    );
    res.json({ user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

tenantUsersRouter.delete("/:id", async (req, res) => {
  try {
    res.json(await deleteTenantUser(req.user.tenantId, req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

tenantUsersRouter.post("/:id/unlock", async (req, res) => {
  try {
    const target = await getUserInTenant(req.params.id, req.user.tenantId);
    if (!target) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    if (isPlatformAdminEmail(target.email)) {
      return res.status(403).json({ error: "Operação não permitida" });
    }
    res.json(await unlockUser(req.user.tenantId, req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

tenantUsersRouter.post("/:id/reset-temporary-password", async (req, res) => {
  try {
    const target = await getUserInTenant(req.params.id, req.user.tenantId);
    if (!target) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }
    if (isPlatformAdminEmail(target.email)) {
      return res.status(403).json({ error: "Operação não permitida" });
    }
    if (target.id === req.user.id) {
      return res.status(403).json({
        error: "Você não pode redefinir sua própria senha por este fluxo",
      });
    }
    res.json(
      await resetTemporaryPasswordForUser(
        req.user.tenantId,
        target.id,
        target.email
      )
    );
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});
