import { Router } from "express";
import { allRoleKeys, GLOBAL_AGENT_ROLE_KEY } from "../lib/agent-roles.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { isPlatformAdminEmail } from "../lib/platform-admin-emails.js";
import { query } from "../db/pool.js";
import { requireActivePlan, requireAuth, requirePasswordReady } from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  listProjectAgentOverrides,
  resetProjectAgentsFromTemplates,
  upsertProjectAgentOverride,
} from "../services/agent-config-service.js";
import {
  getAgentConfigHelpStatus,
  runAgentConfigHelpChat,
} from "../services/agent-config-help-service.js";

export const projectAgentsRouter = Router({ mergeParams: true });
projectAgentsRouter.use(
  requireAuth,
  requirePasswordReady,
  requireActivePlan,
  requireCapability("execute")
);

function assertRoleKey(roleKey) {
  if (!allRoleKeys().includes(roleKey)) {
    const err = new Error(`role_key inválido: ${roleKey}`);
    err.status = 400;
    throw err;
  }
}

function canEditGlobalAgent(email) {
  return isPlatformAdminEmail(email);
}

function assertCanEditAgentRole(email, roleKey) {
  if (roleKey === GLOBAL_AGENT_ROLE_KEY && !canEditGlobalAgent(email)) {
    const err = new Error(
      "O agente Global só pode ser alterado por um administrador da plataforma."
    );
    err.status = 403;
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
    const canEditGlobal = canEditGlobalAgent(req.user.email);
    let overrides = await listProjectAgentOverrides(req.user.tenantId, slug);
    if (!canEditGlobal) {
      overrides = overrides.filter((r) => r.role_key !== GLOBAL_AGENT_ROLE_KEY);
    }
    res.json({
      overrides,
      canEditGlobal,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

projectAgentsRouter.put("/:roleKey", async (req, res) => {
  try {
    assertRoleKey(req.params.roleKey);
    assertCanEditAgentRole(req.user.email, req.params.roleKey);
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
    const preserveRoleKeys = canEditGlobalAgent(req.user.email)
      ? []
      : [GLOBAL_AGENT_ROLE_KEY];
    await resetProjectAgentsFromTemplates(req.user.tenantId, slug, { preserveRoleKeys });
    const overrides = await listProjectAgentOverrides(req.user.tenantId, slug);
    res.json({ ok: true, overrides });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

projectAgentsRouter.get("/help/status", async (req, res) => {
  try {
    const status = await getAgentConfigHelpStatus(req.user.tenantId);
    res.json(status);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

projectAgentsRouter.post("/help/chat", async (req, res) => {
  try {
    const slug = req.params.slug;
    await assertTenantProject(req.user.tenantId, slug);
    const roleKey = String(req.body?.roleKey ?? "").trim();
    if (roleKey) {
      assertRoleKey(roleKey);
      assertCanEditAgentRole(req.user.email, roleKey);
    }
    const result = await runAgentConfigHelpChat(
      req.user.tenantId,
      req.user.id ?? null,
      slug,
      req.body ?? {}
    );
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      code: e.code ?? undefined,
    });
  }
});
