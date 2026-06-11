import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Pasta de volumes do CLI (irmão `ai-factory-cli` ou `TENANT_DATA_DIR`). */
export function tenantDataBase() {
  if (process.env.TENANT_DATA_DIR) {
    return path.resolve(process.env.TENANT_DATA_DIR);
  }
  return path.resolve(__dirname, "../../../ai-factory-cli/data/tenants");
}

/** Raiz do repo ai-factory-cli (contém `scripts/` e `data/tenants/`). */
export function tenantCliRoot() {
  return path.join(tenantDataBase(), "..", "..");
}

/**
 * @param {string} tenantId
 */
export function tenantDataRoot(tenantId) {
  return path.join(tenantDataBase(), tenantId);
}

/**
 * @param {string} tenantId
 */
export function tenantWorkspacesDir(tenantId) {
  return path.join(tenantDataRoot(tenantId), "workspaces");
}

/**
 * @param {string} tenantId
 */
export function tenantMacroDir(tenantId) {
  return path.join(tenantDataRoot(tenantId), "scopes", "macro");
}

/**
 * @param {string} tenantId
 */
export function tenantAgentsDir(tenantId) {
  return path.join(tenantDataRoot(tenantId), "agents");
}

export function ensureTenantDirs(tenantId) {
  fs.mkdirSync(tenantWorkspacesDir(tenantId), { recursive: true });
  fs.mkdirSync(tenantMacroDir(tenantId), { recursive: true });
  fs.mkdirSync(tenantAgentsDir(tenantId), { recursive: true });
}
