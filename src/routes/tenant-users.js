import { Router } from "express";
import { requireActivePlan, requireAuth } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  createTenantUser,
  deleteTenantUser,
  getUserInTenant,
  listTenantUsers,
  setUserPassword,
  updateTenantUserRole,
} from "../services/user-service.js";

export const tenantUsersRouter = Router();
tenantUsersRouter.use(requireAuth, requireActivePlan, requireCapability("manageUsers"));

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
        password: req.body?.password,
      },
      { allowedRoles: AUDITOR_CREATABLE }
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

tenantUsersRouter.put("/:id/password", async (req, res) => {
  try {
    const target = await getUserInTenant(req.params.id, req.user.tenantId);
    if (!target) {
      return res.status(404).json({ error: "Utilizador não encontrado" });
    }
    if (!AUDITOR_CREATABLE.has(target.role)) {
      return res.status(403).json({
        error: "Auditor só define senha de executor ou visualizador",
      });
    }
    res.json(
      await setUserPassword(
        req.user.tenantId,
        req.params.id,
        req.body?.password
      )
    );
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
