import fs from "node:fs";
import path from "node:path";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import { isValidProjectSlug } from "../lib/project-slug.js";

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
function tasksStatePath(tenantId, projectSlug) {
  return path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "tasks-state.json"
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export function readTasksState(tenantId, projectSlug) {
  const p = tasksStatePath(tenantId, projectSlug);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8").replace(/^\uFEFF/, ""));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {object[]} state
 */
export function writeTasksState(tenantId, projectSlug, state) {
  const p = tasksStatePath(tenantId, projectSlug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 */
export function approveTaskHumanValidation(tenantId, projectSlug, taskId) {
  if (!isValidProjectSlug(projectSlug)) {
    throw Object.assign(new Error("Slug inválido"), { status: 400 });
  }
  const state = readTasksState(tenantId, projectSlug);
  const idx = state.findIndex((t) => t.id === taskId);
  if (idx < 0) {
    throw Object.assign(new Error("Task não encontrada no estado"), { status: 404 });
  }
  const item = state[idx];
  if (item.currentAgent !== "Human Approval Pending") {
    throw Object.assign(
      new Error("Task não está aguardando revisão humana"),
      { status: 400 }
    );
  }
  state[idx] = {
    ...item,
    status: "done",
    currentAgent: "Done",
    updatedAt: new Date().toISOString(),
  };
  writeTasksState(tenantId, projectSlug, state);
  return state[idx];
}
