import fs from "node:fs";
import path from "node:path";

/** @type {Set<string>} */
export const DEPLOY_EXCLUDE_DIRS = new Set([
  ".git",
  ".git-cache",
  "agents",
  "tasks",
  "reports",
  "docs",
  "evidence",
  "node_modules",
]);

/**
 * @param {string} dir
 */
export function deployDirectoryHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (DEPLOY_EXCLUDE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile()) return true;
    if (ent.isDirectory() && deployDirectoryHasFiles(full)) return true;
  }
  return false;
}

/**
 * @param {string} srcDir
 * @param {string} destRoot
 */
export function copyDeployTreeFiltered(srcDir, destRoot) {
  if (!fs.existsSync(srcDir)) return;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (DEPLOY_EXCLUDE_DIRS.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destRoot, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyDeployTreeFiltered(src, dest);
    } else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}
