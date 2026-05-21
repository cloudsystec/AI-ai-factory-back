import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  tenantDataRoot,
  tenantMacroDir,
  tenantWorkspacesDir,
} from "../lib/tenant-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_DIR = path.resolve(
  __dirname,
  "../../../ai-factory-cli/orchestrator"
);

/** @type {Promise<{ buildDashboardTasks: Function, getScopeDashboardState: Function, buildTaskDetail: Function, taskStateFile: Function }>|null} */
let orchestratorLoad = null;

async function loadOrchestrator() {
  if (!orchestratorLoad) {
    const base = pathToFileURL(ORCHESTRATOR_DIR).href;
    const [tasksMod, scopeMod, detailMod, pathsMod] = await Promise.all([
      import(`${base}/task-dashboard-tasks.js`),
      import(`${base}/scope-dashboard-state.js`),
      import(`${base}/task-dashboard-detail.js`),
      import(`${base}/project-paths.js`),
    ]);
    orchestratorLoad = Promise.resolve({
      buildDashboardTasks: tasksMod.buildDashboardTasks,
      getScopeDashboardState: scopeMod.getScopeDashboardState,
      buildTaskDetail: detailMod.buildTaskDetail,
      taskStateFile: pathsMod.taskStateFile,
    });
  }
  return orchestratorLoad;
}

/**
 * @param {string} tenantId
 * @param {() => T | Promise<T>} fn
 * @template T
 */
export async function withTenantWorkspaceEnv(tenantId, fn) {
  const prev = {
    root: process.env.AI_FACTORY_TENANT_ROOT,
    ws: process.env.AI_FACTORY_WORKSPACES_DIR,
    macro: process.env.AI_FACTORY_MACRO_DIR,
    active: process.env.AI_FACTORY_ACTIVE_PROJECT,
  };
  process.env.AI_FACTORY_TENANT_ROOT = tenantDataRoot(tenantId);
  process.env.AI_FACTORY_WORKSPACES_DIR = tenantWorkspacesDir(tenantId);
  process.env.AI_FACTORY_MACRO_DIR = tenantMacroDir(tenantId);
  delete process.env.AI_FACTORY_ACTIVE_PROJECT;

  try {
    return await fn();
  } finally {
    if (prev.root === undefined) delete process.env.AI_FACTORY_TENANT_ROOT;
    else process.env.AI_FACTORY_TENANT_ROOT = prev.root;
    if (prev.ws === undefined) delete process.env.AI_FACTORY_WORKSPACES_DIR;
    else process.env.AI_FACTORY_WORKSPACES_DIR = prev.ws;
    if (prev.macro === undefined) delete process.env.AI_FACTORY_MACRO_DIR;
    else process.env.AI_FACTORY_MACRO_DIR = prev.macro;
    if (prev.active === undefined) delete process.env.AI_FACTORY_ACTIVE_PROJECT;
    else process.env.AI_FACTORY_ACTIVE_PROJECT = prev.active;
  }
}

/**
 * @param {string} projectSlug
 */
function loadTasksStateFromDisk(projectSlug, taskStateFile) {
  const statePath = taskStateFile(projectSlug);
  if (!fs.existsSync(statePath)) return [];
  try {
    const raw = JSON.parse(
      fs.readFileSync(statePath, "utf-8").replace(/^\uFEFF/, "")
    );
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @returns {Promise<{ ok: true, tasks: object[] } | { ok: false, error: string }>}
 */
export async function readLiveTasks(tenantId, projectSlug) {
  try {
    return await withTenantWorkspaceEnv(tenantId, async () => {
      const { buildDashboardTasks } = await loadOrchestrator();
      const tasks = buildDashboardTasks(projectSlug);
      return { ok: true, tasks };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @returns {Promise<{ ok: true, scopeState: object } | { ok: false, error: string }>}
 */
export async function readLiveScopeState(tenantId, projectSlug) {
  try {
    return await withTenantWorkspaceEnv(tenantId, async () => {
      const { getScopeDashboardState, taskStateFile } = await loadOrchestrator();
      const tasksState = loadTasksStateFromDisk(projectSlug, taskStateFile);
      const scopeState = getScopeDashboardState(projectSlug, { tasksState });
      return { ok: true, scopeState };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} taskId
 * @returns {Promise<{ ok: true, detail: object } | { ok: false, error: string } | { ok: true, detail: null }>}
 */
export async function readLiveTaskDetail(tenantId, projectSlug, taskId) {
  try {
    return await withTenantWorkspaceEnv(tenantId, async () => {
      const { buildTaskDetail } = await loadOrchestrator();
      const detail = buildTaskDetail(projectSlug, taskId);
      return { ok: true, detail };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
