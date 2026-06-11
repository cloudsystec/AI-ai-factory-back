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
import {
  createTenantUser,
  deleteTenantUser,
  getUserInTenant,
  listTenantUsers,
  setExecutorCursorApiKey,
  setTenantUsersMax,
  updateTenantUserRole,
  ROLES,
} from "../services/user-service.js";
import {
  resetTemporaryPasswordForUser,
  unlockUser,
} from "../services/password-security-service.js";
import {
  setTenantCursorAdminKey,
  upsertTenant,
} from "../services/tenant-service.js";
import { afterTenantCreated } from "../services/tenant-onboarding-service.js";
import {
  blockTenant,
  isTenantBlocked,
  unblockTenant,
} from "../services/tenant-block-service.js";
import {
  countBotsReady,
  ensureWorkerBotRows,
  listWorkersStatus,
  setBotConfigForSlot,
} from "../services/worker-bot-service.js";
import {
  getWorkerDeployment,
  deployWorkerForTenant,
  retryWorkerProvision,
} from "../services/worker-deployment-service.js";
import { listJobBillingCalls } from "../services/billing-call-service.js";

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
    `SELECT t.id, t.email, t.name, t.plan_id, t.plan_active_until,
            t.users_max, t.agent_slots_max, t.worker_status,
            t.blocked_at, t.block_reason, t.block_note, t.blocked_by,
            d.status AS worker_deploy_status,
            d.railway_service_id,
            d.last_error AS worker_deploy_error,
            d.provisioned_at AS worker_provisioned_at
     FROM tenants t
     LEFT JOIN tenant_worker_deployments d ON d.tenant_id = t.id
     ORDER BY COALESCE(NULLIF(t.name, ''), t.email)`
  );
  const tenants = await Promise.all(
    rows.map(async (t) => {
      const botsConfiguredCount = await countBotsReady(t.id);
      return {
        ...t,
        isBlocked: isTenantBlocked(t),
        botsTotal: t.agent_slots_max,
        botsConfiguredCount,
        workerDeployStatus: t.worker_deploy_status || null,
        workerStatus: t.worker_status,
        railwayServiceId: t.railway_service_id
          ? `${String(t.railway_service_id).slice(0, 8)}…`
          : null,
        workerDeployError: t.worker_deploy_error || null,
        workerProvisionedAt: t.worker_provisioned_at || null,
      };
    })
  );
  res.json({ tenants });
});

adminRouter.post("/tenants/:tenantId/block", async (req, res) => {
  try {
    const result = await blockTenant(req.params.tenantId, {
      reason: req.body?.reason,
      note: req.body?.note,
      blockedBy: req.user.email,
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
    });
  }
});

adminRouter.post("/tenants/:tenantId/unblock", async (req, res) => {
  try {
    const result = await unblockTenant(req.params.tenantId, {
      unblockedBy: req.user.email,
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message,
      code: e.code,
    });
  }
});

adminRouter.post("/tenants/:tenantId/worker/provision", async (req, res) => {
  const { tenantId } = req.params;
  const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  if (!rows[0]) {
    return res.status(404).json({ error: "Tenant não encontrado" });
  }
  try {
    const result = await retryWorkerProvision(tenantId);
    const deployment = await getWorkerDeployment(tenantId);
    res.json({ ok: true, result, deployment });
  } catch (e) {
    const deployment = await getWorkerDeployment(tenantId);
    res.status(500).json({
      error: e instanceof Error ? e.message : "provision failed",
      deployment,
    });
  }
});

adminRouter.post("/tenants/:tenantId/worker/deploy", async (req, res) => {
  const { tenantId } = req.params;
  const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
    tenantId,
  ]);
  if (!rows[0]) {
    return res.status(404).json({ error: "Tenant não encontrado" });
  }
  try {
    const result = await deployWorkerForTenant(tenantId);
    const deployment = await getWorkerDeployment(tenantId);
    res.json({ ok: true, result, deployment });
  } catch (e) {
    const deployment = await getWorkerDeployment(tenantId);
    res.status(500).json({
      error: e instanceof Error ? e.message : "deploy failed",
      deployment,
    });
  }
});

adminRouter.post("/tenants", async (req, res) => {
  try {
    const { email, name, planId, planDays, auditorEmail } = req.body || {};

    if (!email || !name) {
      return res
        .status(400)
        .json({ error: "email e name da empresa são obrigatórios" });
    }
    if (!auditorEmail) {
      return res.status(400).json({ error: "auditorEmail é obrigatório" });
    }

    const tenant = await upsertTenant({ email, name, planId, planDays });

    const auditor = await createTenantUser(
      tenant.id,
      { email: auditorEmail, role: "auditor" },
      { allowedRoles: ROLES, tenantName: name }
    );

    const workerSetup = await afterTenantCreated(tenant.id);

    res.status(201).json({ tenant, auditor, workerSetup });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ error: e.message, code: e.code });
  }
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

adminRouter.get("/tenants/:tenantId/users", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    res.json(await listTenantUsers(req.params.tenantId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

adminRouter.get("/tenants/:tenantId/jobs/:jobId/billing-calls", async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id FROM jobs WHERE id = $1 AND tenant_id = $2",
      [req.params.jobId, req.params.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Job não encontrado" });
    const calls = await listJobBillingCalls(
      req.params.tenantId,
      req.params.jobId
    );
    res.json({ calls });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.post("/tenants/:tenantId/users", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    const user = await createTenantUser(
      req.params.tenantId,
      {
        email: req.body?.email,
        role: req.body?.role,
      },
      { allowedRoles: ROLES }
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

adminRouter.patch("/tenants/:tenantId/users/:userId", async (req, res) => {
  try {
    const user = await updateTenantUserRole(
      req.params.tenantId,
      req.params.userId,
      { role: req.body?.role },
      { allowedRoles: ROLES }
    );
    res.json({ user });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.delete("/tenants/:tenantId/users/:userId", async (req, res) => {
  try {
    res.json(await deleteTenantUser(req.params.tenantId, req.params.userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.post("/tenants/:tenantId/users/:userId/unlock", async (req, res) => {
  try {
    const target = await getUserInTenant(req.params.userId, req.params.tenantId);
    if (!target) return res.status(404).json({ error: "Usuário não encontrado" });
    res.json(await unlockUser(req.params.tenantId, req.params.userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.post(
  "/tenants/:tenantId/users/:userId/reset-temporary-password",
  async (req, res) => {
    try {
      const target = await getUserInTenant(req.params.userId, req.params.tenantId);
      if (!target) return res.status(404).json({ error: "Usuário não encontrado" });
      res.json(
        await resetTemporaryPasswordForUser(
          req.params.tenantId,
          target.id,
          target.email
        )
      );
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }
);

adminRouter.put("/tenants/:tenantId/users/:userId/cursor-api-key", async (req, res) => {
  try {
    res.json(
      await setExecutorCursorApiKey(
        req.params.tenantId,
        req.params.userId,
        req.body?.cursorApiKey
      )
    );
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.get("/tenants/:tenantId/workers", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    res.json(await listWorkersStatus(req.params.tenantId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.get("/tenants/:tenantId/workers/:slot", async (req, res) => {
  try {
    const slot = Number(req.params.slot);
    const status = await listWorkersStatus(req.params.tenantId);
    const worker = status.workers.find((w) => w.slot === slot);
    if (!worker) {
      return res.status(404).json({ error: "Slot não encontrado" });
    }
    res.json({ worker, slotsMax: status.slotsMax });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.put("/tenants/:tenantId/workers/:slot", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    const slot = Number(req.params.slot);
    const worker = await setBotConfigForSlot(req.params.tenantId, slot, {
      botEmail: req.body?.botEmail,
      cursorWorkerApiKey: req.body?.cursorWorkerApiKey,
    });
    res.json({ worker });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, code: e.code });
  }
});

adminRouter.put("/tenants/:tenantId/cursor-admin-key", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    await setTenantCursorAdminKey(
      req.params.tenantId,
      req.body?.cursorAdminApiKey
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

adminRouter.patch("/tenants/:tenantId", async (req, res) => {
  try {
    const { rows } = await query("SELECT id FROM tenants WHERE id = $1", [
      req.params.tenantId,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "Tenant não encontrado" });
    if (req.body?.usersMax != null) {
      const r = await setTenantUsersMax(req.params.tenantId, req.body.usersMax);
      return res.json({ ok: true, ...r });
    }
    if (req.body?.agentSlotsMax != null) {
      const n = Number(req.body.agentSlotsMax);
      if (!Number.isInteger(n) || n < 1 || n > 32) {
        return res.status(400).json({ error: "agentSlotsMax deve ser inteiro 1–32" });
      }
      await query(
        `UPDATE tenants SET agent_slots_max = $2, updated_at = now() WHERE id = $1`,
        [req.params.tenantId, n]
      );
      const { ensureWorkerBotRows } = await import("../services/worker-bot-service.js");
      await ensureWorkerBotRows(req.params.tenantId);
      return res.json({ ok: true, agentSlotsMax: n });
    }
    res.status(400).json({ error: "Nada para atualizar" });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

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
