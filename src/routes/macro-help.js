import { Router } from "express";
import { requireActivePlan, requireAuth, attachCapabilities } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  getMacroHelpStatus,
  runMacroHelpChat,
} from "../services/macro-help-service.js";

export const macroHelpRouter = Router();

macroHelpRouter.use(requireAuth, attachCapabilities, requireActivePlan);

macroHelpRouter.get("/status", requireCapability("write"), async (req, res) => {
  const status = await getMacroHelpStatus(req.user.tenantId);
  res.json(status);
});

macroHelpRouter.post("/chat", requireCapability("write"), async (req, res) => {
  try {
    const result = await runMacroHelpChat(
      req.user.tenantId,
      req.user.id ?? null,
      req.body ?? {}
    );
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
    });
  }
});
