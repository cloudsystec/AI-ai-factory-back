import { Router } from "express";
import { allRoleKeys } from "../lib/agent-roles.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { query } from "../db/pool.js";
import { requireActivePlan, requireAuth } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  listProjectAgentOverrides,
  resetProjectAgentsFromTemplates,
  upsertProjectAgentOverride,
} from "../services/agent-config-service.js";

export const projectAgentsRouter = Router({ mergeParams: true });
projectAgentsRouter.use(
  requireAuth,
  requireActivePlan,
  requireCapability("write")
);

function assertRoleKey(roleKey) {
  if (!allRoleKeys().includes(roleKey)) {
    const err = new Error(`role_key inválido: ${roleKey}`);
    err.status = 400;
    throw err;
  }
}

async function assertTenantProject(tenantId, slug) {
  if (!isValidProjectSlug(slug)) {
    const err = new Error("slug de projeto inválido");
    err.status = 400;
    throw err;
  }
  const { rows } = await query(
    "SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, slug]
  );
  if (!rows[0]) {
    const err = new Error("Projeto não encontrado");
    err.status = 404;
    throw err;
  }
}

projectAgentsRouter.get("/", async (req, res) => {
  try {
    const slug = req.params.slug;
    await assertTenantProject(req.user.tenantId, slug);
    const overrides = await listProjectAgentOverrides(req.user.tenantId, slug);
    res.json({ overrides });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

projectAgentsRouter.put("/:roleKey", async (req, res) => {
  try {
    assertRoleKey(req.params.roleKey);
    const slug = req.params.slug;
    await assertTenantProject(req.user.tenantId, slug);
    const content = req.body?.content;
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content string obrigatório" });
    }
    const row = await upsertProjectAgentOverride(
      req.user.tenantId,
      slug,
      req.params.roleKey,
      content
    );
    res.json({ override: row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

projectAgentsRouter.post("/reset", async (req, res) => {
  try {
    const slug = req.params.slug;
    await assertTenantProject(req.user.tenantId, slug);
    await resetProjectAgentsFromTemplates(req.user.tenantId, slug);
    const overrides = await listProjectAgentOverrides(req.user.tenantId, slug);
    res.json({ ok: true, overrides });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
