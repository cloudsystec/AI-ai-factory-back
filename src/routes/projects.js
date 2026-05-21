import { Router } from "express";
import { query } from "../db/pool.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { requireActivePlan, requireAuth, attachCapabilities } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import { queueProvisionJob } from "../services/job-service.js";
import { cloneAgentTemplatesToProject } from "../services/agent-config-service.js";
import { resetProjectPlanning } from "../services/project-reset-service.js";

export const projectsRouter = Router();
projectsRouter.use(requireAuth, attachCapabilities, requireActivePlan);

projectsRouter.get("/", async (req, res) => {
  const { rows } = await query(
    "SELECT slug, name, created_at FROM projects WHERE tenant_id = $1 ORDER BY slug",
    [req.user.tenantId]
  );
  res.json(rows.map((r) => r.slug));
});

projectsRouter.post("/", requireCapability("write"), async (req, res) => {
  const { name, slug, scope } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  const trimmedSlug = String(slug ?? "").trim();
  const trimmedScope = String(scope ?? "").trim();

  if (!trimmedName) {
    return res.status(400).json({ error: "Nome do projeto é obrigatório." });
  }
  if (!trimmedScope) {
    return res.status(400).json({ error: "Escopo é obrigatório." });
  }
  if (!trimmedSlug) {
    return res.status(400).json({ error: "Slug é obrigatório." });
  }
  if (!isValidProjectSlug(trimmedSlug)) {
    return res.status(400).json({
      error: `Slug inválido: "${trimmedSlug}". Use apenas letras, números, hífen e underscore.`,
    });
  }

  const { rows: existing } = await query(
    "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",
    [req.user.tenantId, trimmedSlug]
  );
  if (existing[0]) {
    return res.status(409).json({ error: `Projeto "${trimmedSlug}" já existe.` });
  }

  try {
    await query(
      `INSERT INTO projects (tenant_id, slug, name, scope_md) VALUES ($1, $2, $3, $4)`,
      [req.user.tenantId, trimmedSlug, trimmedName, trimmedScope]
    );
    await cloneAgentTemplatesToProject(req.user.tenantId, trimmedSlug);
    const queued = await queueProvisionJob(req.user.tenantId, {
      slug: trimmedSlug,
      name: trimmedName,
      scope: trimmedScope,
    });
    res.status(201).json({
      project: trimmedSlug,
      macroId: trimmedSlug,
      name: trimmedName,
      jobId: queued.jobId,
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      await query(
        "DELETE FROM projects WHERE tenant_id = $1 AND slug = $2",
        [req.user.tenantId, trimmedSlug]
      ).catch(() => {});
    }
    res.status(status).json({
      error: error.message,
      code: error.code,
    });
  }
});

projectsRouter.post("/:slug/reset", requireCapability("write"), async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!isValidProjectSlug(slug)) {
    return res.status(400).json({ error: "Slug inválido" });
  }
  try {
    const result = await resetProjectPlanning(req.user.tenantId, slug);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
    });
  }
});
