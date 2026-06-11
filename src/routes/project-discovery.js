import { Router } from "express";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import { getMacroHelpStatus } from "../services/macro-help-service.js";
import {
  createDiscoverySession,
  deleteDiscoverySession,
  getDiscoverySession,
  runDiscoveryChat,
} from "../services/project-discovery-service.js";

export const projectDiscoveryRouter = Router();

projectDiscoveryRouter.use(
  requireAuth,
  requirePasswordReady,
  attachCapabilities,
  requireActivePlan
);

projectDiscoveryRouter.get("/status", requireCapability("write"), async (req, res) => {
  const status = await getMacroHelpStatus(req.user.tenantId);
  res.json(status);
});

projectDiscoveryRouter.post("/sessions", requireCapability("write"), async (req, res) => {
  try {
    const session = await createDiscoverySession(
      req.user.tenantId,
      req.user.id ?? null
    );
    res.status(201).json(session);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
    });
  }
});

projectDiscoveryRouter.get(
  "/sessions/:id",
  requireCapability("write"),
  async (req, res) => {
    try {
      const session = await getDiscoverySession(
        req.user.tenantId,
        req.params.id
      );
      res.json(session);
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({
        error: err.message || String(err),
        code: err.code ?? undefined,
      });
    }
  }
);

projectDiscoveryRouter.post(
  "/sessions/:id/chat",
  requireCapability("write"),
  async (req, res) => {
    try {
      const session = await runDiscoveryChat(
        req.user.tenantId,
        req.user.id ?? null,
        req.params.id,
        req.body?.message
      );
      res.json(session);
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({
        error: err.message || String(err),
        code: err.code ?? undefined,
      });
    }
  }
);

projectDiscoveryRouter.delete(
  "/sessions/:id",
  requireCapability("write"),
  async (req, res) => {
    try {
      await deleteDiscoverySession(req.user.tenantId, req.params.id);
      res.status(204).end();
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({
        error: err.message || String(err),
        code: err.code ?? undefined,
      });
    }
  }
);
