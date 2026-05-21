import { Router } from "express";
import { allRoleKeys } from "../lib/agent-roles.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { requirePlatformAdmin } from "../middleware/platform-admin.js";
import { query } from "../db/pool.js";
import {
  listAgentTemplates,
  listProjectAgentOverrides,
  resetProjectAgentsFromTemplates,
  upsertAgentTemplate,
  upsertProjectAgentOverride,
} from "../services/agent-config-service.js";

export const adminRouter = Router();
adminRouter.use(requirePlatformAdmin);

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

adminRouter.get("/tenants", async (_req, res) => {
  const { rows } = await query(
    "SELECT id, email, plan_id, plan_active_until FROM tenants ORDER BY email"
  );
  res.json({ tenants: rows });
});

adminRouter.get("/tenants/:tenantId/projects", async (req, res) => {
  const { rows: tenants } = await query("SELECT id FROM tenants WHERE id = $1", [
    req.params.tenantId,
  ]);
  if (!tenants[0]) return res.status(404).json({ error: "Tenant não encontrado" });
  const { rows } = await query(
    "SELECT slug, name, created_at FROM projects WHERE tenant_id = $1 ORDER BY slug",
    [req.params.tenantId]
  );
  res.json({ projects: rows });
});

adminRouter.get("/agent-templates", async (_req, res) => {
  const rows = await listAgentTemplates();
  res.json({ templates: rows });
});

adminRouter.put("/agent-templates/:roleKey", async (req, res) => {
  try {
    assertRoleKey(req.params.roleKey);
    const content = req.body?.content;
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "content obrigatório" });
    }
    const row = await upsertAgentTemplate(
      req.params.roleKey,
      content,
      req.user.email
    );
    res.json({ template: row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.get("/tenants/:tenantId/projects/:slug/agents", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    await assertTenantProject(req.params.tenantId, req.params.slug);
    const overrides = await listProjectAgentOverrides(
      req.params.tenantId,
      req.params.slug
    );
    res.json({
      tenantId: req.params.tenantId,
      projectSlug: req.params.slug,
      overrides,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.put(
  "/tenants/:tenantId/projects/:slug/agents/:roleKey",
  async (req, res) => {
    try {
      assertRoleKey(req.params.roleKey);
      const content = req.body?.content;
      if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "content obrigatório" });
      }
      const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
        req.params.tenantId,
      ]);
      if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
      await assertTenantProject(req.params.tenantId, req.params.slug);
      const row = await upsertProjectAgentOverride(
        req.params.tenantId,
        req.params.slug,
        req.params.roleKey,
        content
      );
      res.json({ override: row });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }
);

adminRouter.post(
  "/tenants/:tenantId/projects/:slug/agents/reset",
  async (req, res) => {
    try {
      const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
        req.params.tenantId,
      ]);
      if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
      await assertTenantProject(req.params.tenantId, req.params.slug);
      await resetProjectAgentsFromTemplates(
        req.params.tenantId,
        req.params.slug
      );
      const overrides = await listProjectAgentOverrides(
        req.params.tenantId,
        req.params.slug
      );
      res.json({ ok: true, overrides });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }
);
