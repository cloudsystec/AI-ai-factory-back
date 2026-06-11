import { Router } from "express";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";
import {
  clearCopilotHistory,
  confirmProjectCopilotAction,
  getCopilotGuardStatus,
  getProjectCopilotStatus,
  listCopilotMessages,
  runProjectCopilotChat,
} from "../services/project-copilot-service.js";

export const projectCopilotRouter = Router({ mergeParams: true });

projectCopilotRouter.use(
  requireAuth,
  requirePasswordReady,
  attachCapabilities,
  requireActivePlan
);

projectCopilotRouter.get("/status", async (req, res) => {
  try {
    const status = await getProjectCopilotStatus(req.user.tenantId);
    const guard = await getCopilotGuardStatus(
      req.user.tenantId,
      req.user.id
    );
    res.json({ ...status, guard });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
    });
  }
});

projectCopilotRouter.get("/history", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const messages = await listCopilotMessages(
      req.user.tenantId,
      slug,
      req.user.id,
      Number(req.query.limit) || 50
    );
    res.json({ messages });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

projectCopilotRouter.delete("/history", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    await clearCopilotHistory(req.user.tenantId, slug, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || String(err) });
  }
});

projectCopilotRouter.post("/chat", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  const message = req.body?.message ?? req.body?.content;
  try {
    const result = await runProjectCopilotChat(
      req.user.tenantId,
      req.user.id,
      slug,
      req.capabilities || {},
      message
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
      lockedUntil: err.lockedUntil,
      strikes: err.strikes,
      maxStrikes: err.maxStrikes,
    });
  }
});

projectCopilotRouter.post("/confirm", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  const actionId = String(req.body?.actionId ?? "").trim();
  const forceStop = req.body?.forceStop === true;
  if (!actionId) {
    return res.status(400).json({ error: "actionId obrigatório" });
  }
  try {
    res.json(
      await confirmProjectCopilotAction(
        req.user.tenantId,
        req.user.id,
        slug,
        req.capabilities || {},
        actionId,
        { forceStop }
      )
    );
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
    });
  }
});
