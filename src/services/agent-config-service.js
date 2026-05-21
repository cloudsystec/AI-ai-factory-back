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
 * @param {string} projectSlug
 */
export async function cloneAgentTemplatesToProject(tenantId, projectSlug) {
  const { rows: templates } = await query(
    "SELECT role_key, content FROM agent_templates"
  );
  for (const t of templates) {
    await query(
      `INSERT INTO project_agent_overrides (tenant_id, project_slug, role_key, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, project_slug, role_key) DO NOTHING`,
      [tenantId, projectSlug, t.role_key, t.content]
    );
  }
}

/**
 * Garante overrides do projeto (clone lazy se vazio).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function ensureProjectAgentOverrides(tenantId, projectSlug) {
  const { rows } = await query(
    `SELECT 1 FROM project_agent_overrides
     WHERE tenant_id = $1 AND project_slug = $2 LIMIT 1`,
    [tenantId, projectSlug]
  );
  if (!rows[0]) {
    await cloneAgentTemplatesToProject(tenantId, projectSlug);
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @returns {Promise<Record<string, string>>}
 */
export async function getEffectiveAgentConfigForProject(tenantId, projectSlug) {
  await ensureProjectAgentOverrides(tenantId, projectSlug);

  const { rows: overrides } = await query(
    `SELECT role_key, content FROM project_agent_overrides
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
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
 * @param {string} projectSlug
 */
export async function listProjectAgentOverrides(tenantId, projectSlug) {
  await ensureProjectAgentOverrides(tenantId, projectSlug);
  const { rows } = await query(
    `SELECT role_key, content, updated_at FROM project_agent_overrides
     WHERE tenant_id = $1 AND project_slug = $2 ORDER BY role_key`,
    [tenantId, projectSlug]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} roleKey
 * @param {string} content
 */
export async function upsertProjectAgentOverride(
  tenantId,
  projectSlug,
  roleKey,
  content
) {
  await ensureProjectAgentOverrides(tenantId, projectSlug);
  const { rows } = await query(
    `INSERT INTO project_agent_overrides (tenant_id, project_slug, role_key, content, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, project_slug, role_key) DO UPDATE SET
       content = EXCLUDED.content,
       updated_at = now()
     RETURNING *`,
    [tenantId, projectSlug, roleKey, content]
  );
  return rows[0];
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function resetProjectAgentsFromTemplates(tenantId, projectSlug) {
  await query(
    `DELETE FROM project_agent_overrides WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  await cloneAgentTemplatesToProject(tenantId, projectSlug);
}

/**
 * Clona templates para todos os projetos existentes de um tenant (seed / migração manual).
 * @param {string} tenantId
 */
export async function cloneAgentTemplatesToAllTenantProjects(tenantId) {
  const { rows: projects } = await query(
    "SELECT slug FROM projects WHERE tenant_id = $1",
    [tenantId]
  );
  for (const p of projects) {
    await cloneAgentTemplatesToProject(tenantId, p.slug);
  }
}
