import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";

const HISTORY_LIMIT = 80;
const PENDING_TTL_MS = 2 * 60 * 1000;

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} userId
 * @param {number} [limit]
 */
export async function listCopilotMessages(
  tenantId,
  projectSlug,
  userId,
  limit = 50
) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), HISTORY_LIMIT);
  const { rows } = await query(
    `SELECT id, role, content, metadata, created_at
     FROM project_copilot_messages
     WHERE tenant_id = $1 AND project_slug = $2 AND user_id = $3
     ORDER BY created_at ASC
     LIMIT $4`,
    [tenantId, projectSlug, userId, lim]
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    metadata: r.metadata || {},
    createdAt: r.created_at,
  }));
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} userId
 * @param {string} role
 * @param {string} content
 * @param {object} [metadata]
 */
export async function appendCopilotMessage(
  tenantId,
  projectSlug,
  userId,
  role,
  content,
  metadata = {}
) {
  const id = randomUUID();
  await query(
    `INSERT INTO project_copilot_messages
       (id, tenant_id, project_slug, user_id, role, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, tenantId, projectSlug, userId, role, content, JSON.stringify(metadata)]
  );
  return id;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} userId
 */
export async function clearCopilotHistory(tenantId, projectSlug, userId) {
  await query(
    `DELETE FROM project_copilot_messages
     WHERE tenant_id = $1 AND project_slug = $2 AND user_id = $3`,
    [tenantId, projectSlug, userId]
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} userId
 * @param {string} actionType
 * @param {object} payload
 * @param {string} summary
 */
export async function createPendingAction(
  tenantId,
  projectSlug,
  userId,
  actionType,
  payload,
  summary
) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  await query(
    `INSERT INTO project_copilot_pending_actions
       (id, tenant_id, project_slug, user_id, action_type, payload, summary, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      id,
      tenantId,
      projectSlug,
      userId,
      actionType,
      JSON.stringify(payload || {}),
      String(summary || "").slice(0, 2000),
      expiresAt,
    ]
  );
  return { id, actionType, summary, expiresAt: expiresAt.toISOString() };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} userId
 * @param {string} actionId
 */
export async function loadPendingAction(tenantId, projectSlug, userId, actionId) {
  const { rows } = await query(
    `SELECT id, action_type, payload, summary, expires_at, confirmed_at
     FROM project_copilot_pending_actions
     WHERE id = $1 AND tenant_id = $2 AND project_slug = $3 AND user_id = $4`,
    [actionId, tenantId, projectSlug, userId]
  );
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error("Ação pendente não encontrada."), { status: 404 });
  }
  if (row.confirmed_at) {
    throw Object.assign(new Error("Ação já confirmada."), { status: 409 });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("Ação expirada — peça novamente ao copiloto."), {
      status: 410,
    });
  }
  return {
    id: row.id,
    actionType: row.action_type,
    payload: row.payload || {},
    summary: row.summary,
    expiresAt: row.expires_at,
  };
}

/**
 * @param {string} actionId
 */
export async function markPendingActionConfirmed(actionId) {
  await query(
    `UPDATE project_copilot_pending_actions SET confirmed_at = now() WHERE id = $1`,
    [actionId]
  );
}
