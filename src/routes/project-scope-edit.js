import { Router } from "express";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  getEditabilityReport,
  updateMicroAndRegenerateTasks,
  updateTaskFields,
} from "../services/project-scope-edit-service.js";

export const projectScopeEditRouter = Router({ mergeParams: true });

projectScopeEditRouter.use(
  requireAuth,
  requirePasswordReady,
  attachCapabilities,
  requireActivePlan
);

projectScopeEditRouter.get("/editability", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    res.json(await getEditabilityReport(req.user.tenantId, slug));
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || String(err),
      code: err.code ?? undefined,
    });
  }
});

projectScopeEditRouter.patch(
  "/tasks/:taskId",
  requireCapability("write"),
  async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    const taskId = String(req.params.taskId ?? "").trim();
    if (!isValidProjectSlug(slug)) {
      return res.status(400).json({ error: "Slug inválido" });
    }
    try {
      res.json(
        await updateTaskFields(req.user.tenantId, slug, taskId, req.body ?? {})
      );
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message || String(err),
        code: err.code ?? undefined,
      });
    }
  }
);

projectScopeEditRouter.patch(
  "/micros/:microId",
  requireCapability("write"),
  async (req, res) => {
    const slug = String(req.params.slug ?? "").trim();
    const microId = String(req.params.microId ?? "").trim();
    if (!isValidProjectSlug(slug)) {
      return res.status(400).json({ error: "Slug inválido" });
    }
  const { patch, instructions, ...rest } = req.body ?? {};
  const effectivePatch =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? patch
      : Object.fromEntries(
          Object.entries(rest).filter(([key]) => key !== "instructions")
        );
  try {
    res.json(
      await updateMicroAndRegenerateTasks(
        req.user.tenantId,
        slug,
        microId,
        effectivePatch,
        instructions ?? "",
        req.user.id ?? null
      )
    );
    } catch (err) {
      res.status(err.status || 500).json({
        error: err.message || String(err),
        code: err.code ?? undefined,
      });
    }
  }
);
