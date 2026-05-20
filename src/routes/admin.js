import { Router } from "express";
import { allRoleKeys } from "../lib/agent-roles.js";
import { requirePlatformAdmin } from "../middleware/platform-admin.js";
import { query } from "../db/pool.js";
import {
  listAgentTemplates,
  listTenantAgentOverrides,
  resetTenantAgentsFromTemplates,
  upsertAgentTemplate,
  upsertTenantAgentOverride,
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

adminRouter.get("/tenants", async (_req, res) => {
  const { rows } = await query(
    "SELECT id, email, plan_id, plan_active_until FROM tenants ORDER BY email"
  );
  res.json({ tenants: rows });
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

adminRouter.get("/tenants/:tenantId/agents", async (req, res) => {
  const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
    req.params.tenantId,
  ]);
  if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
  const overrides = await listTenantAgentOverrides(req.params.tenantId);
  res.json({ tenantId: req.params.tenantId, overrides });
});

adminRouter.put("/tenants/:tenantId/agents/:roleKey", async (req, res) => {
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
    const row = await upsertTenantAgentOverride(
      req.params.tenantId,
      req.params.roleKey,
      content
    );
    res.json({ override: row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.post("/tenants/:tenantId/agents/reset", async (req, res) => {
  const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
    req.params.tenantId,
  ]);
  if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
  await resetTenantAgentsFromTemplates(req.params.tenantId);
  const overrides = await listTenantAgentOverrides(req.params.tenantId);
  res.json({ ok: true, overrides });
});
