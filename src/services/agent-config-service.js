import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../db/pool.js";
import { AGENT_ROLES } from "../lib/agent-roles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Raiz deste repo (`agents/` na raiz do back). */
function resolveAgentsRepoRoot() {
  const root = path.resolve(__dirname, "../..");
  if (!fs.existsSync(path.join(root, "agents", "planner.md"))) {
    throw new Error("Pasta agents/ em falta na raiz do repo back");
  }
  return root;
}

const REPO_ROOT = resolveAgentsRepoRoot();

/**
 * Lê ficheiros legados do repo para seed inicial.
 */
export function loadDefaultAgentContentFromRepo() {
  /** @type {Record<string, string>} */
  const roles = {};
  for (const { roleKey, file } of AGENT_ROLES) {
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) {
      console.warn(`Seed: ficheiro em falta ${abs}`);
      continue;
    }
    roles[roleKey] = fs.readFileSync(abs, "utf-8").replace(/^\uFEFF/, "");
  }
  return roles;
}

/**
 * Popula agent_templates a partir do repo (idempotente por role_key).
 */
export async function seedAgentTemplatesFromRepo() {
  const roles = loadDefaultAgentContentFromRepo();
  for (const [roleKey, content] of Object.entries(roles)) {
    await query(
      `INSERT INTO agent_templates (role_key, content, updated_by)
       VALUES ($1, $2, 'seed')
       ON CONFLICT (role_key) DO NOTHING`,
      [roleKey, content]
    );
  }
  return Object.keys(roles).length;
}

/**
 * @param {string} tenantId
 */
export async function cloneAgentTemplatesToTenant(tenantId) {
  const { rows: templates } = await query(
    "SELECT role_key, content FROM agent_templates"
  );
  for (const t of templates) {
    await query(
      `INSERT INTO tenant_agent_overrides (tenant_id, role_key, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, role_key) DO NOTHING`,
      [tenantId, t.role_key, t.content]
    );
  }
}

/**
 * @param {string} tenantId
 * @returns {Promise<Record<string, string>>}
 */
export async function getEffectiveAgentConfigForTenant(tenantId) {
  const { rows: overrides } = await query(
    "SELECT role_key, content FROM tenant_agent_overrides WHERE tenant_id = $1",
    [tenantId]
  );
  if (overrides.length > 0) {
    return Object.fromEntries(overrides.map((r) => [r.role_key, r.content]));
  }
  const { rows: templates } = await query(
    "SELECT role_key, content FROM agent_templates"
  );
  return Object.fromEntries(templates.map((r) => [r.role_key, r.content]));
}

export async function listAgentTemplates() {
  const { rows } = await query(
    "SELECT role_key, content, updated_at, updated_by FROM agent_templates ORDER BY role_key"
  );
  return rows;
}

/**
 * @param {string} roleKey
 * @param {string} content
 * @param {string} [updatedBy]
 */
export async function upsertAgentTemplate(roleKey, content, updatedBy) {
  const { rows } = await query(
    `INSERT INTO agent_templates (role_key, content, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (role_key) DO UPDATE SET
       content = EXCLUDED.content,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [roleKey, content, updatedBy || null]
  );
  return rows[0];
}

/**
 * @param {string} tenantId
 */
export async function listTenantAgentOverrides(tenantId) {
  const { rows } = await query(
    `SELECT role_key, content, updated_at FROM tenant_agent_overrides
     WHERE tenant_id = $1 ORDER BY role_key`,
    [tenantId]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} roleKey
 * @param {string} content
 */
export async function upsertTenantAgentOverride(tenantId, roleKey, content) {
  const { rows } = await query(
    `INSERT INTO tenant_agent_overrides (tenant_id, role_key, content, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, role_key) DO UPDATE SET
       content = EXCLUDED.content,
       updated_at = now()
     RETURNING *`,
    [tenantId, roleKey, content]
  );
  return rows[0];
}

/**
 * @param {string} tenantId
 */
export async function resetTenantAgentsFromTemplates(tenantId) {
  await query("DELETE FROM tenant_agent_overrides WHERE tenant_id = $1", [
    tenantId,
  ]);
  await cloneAgentTemplatesToTenant(tenantId);
}
