import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  tenantDataRoot,
  tenantMacroDir,
  tenantWorkspacesDir,
} from "./tenant-paths.js";

/**
 * @returns {{ date: string, time: string, iso: string }}
 */
export function backupTimestamp() {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 19).replace(/:/g, "-");
  return { date, time, iso: d.toISOString() };
}

/**
 * @param {string} tenantId
 */
export function tenantBackupBaseDir(tenantId) {
  return path.join(tenantDataRoot(tenantId), "BACKUP");
}

/**
 * @param {string} sourceDir
 * @param {string} zipPath
 */
export function zipDirectory(sourceDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const result = spawnSync(
    tar,
    ["-a", "-c", "-f", zipPath, "-C", sourceDir, "."],
    { encoding: "utf-8", windowsHide: true }
  );

  if (result.status !== 0) {
    throw new Error(
      `Falha ao criar ZIP (${zipPath}): ${result.stderr || result.stdout || "tar exit " + result.status}`
    );
  }
}

/**
 * Copia workspace + macro do projeto para staging e gera ZIP em BACKUP/YYYY-MM-DD/.
 * @param {string} tenantId
 * @param {string} slug
 * @param {{ name: string, scopeMd: string }} meta
 */
export function backupProjectToZip(tenantId, slug, meta) {
  const { date, time, iso } = backupTimestamp();
  const backupDayDir = path.join(tenantBackupBaseDir(tenantId), date);
  const stagingDir = path.join(backupDayDir, `_staging_${slug}_${time}`);
  const zipFileName = `${slug}_${time}.zip`;
  const zipPath = path.join(backupDayDir, zipFileName);

  fs.mkdirSync(stagingDir, { recursive: true });

  const wsRoot = path.join(tenantWorkspacesDir(tenantId), slug);
  const macroPath = path.join(tenantMacroDir(tenantId), `${slug}.md`);
  let hadContent = false;

  if (fs.existsSync(wsRoot)) {
    const destWs = path.join(stagingDir, "workspace", slug);
    fs.cpSync(wsRoot, destWs, { recursive: true });
    hadContent = true;
  }

  if (fs.existsSync(macroPath)) {
    const destMacroDir = path.join(stagingDir, "scopes", "macro");
    fs.mkdirSync(destMacroDir, { recursive: true });
    fs.cpSync(macroPath, path.join(destMacroDir, `${slug}.md`));
    hadContent = true;
  }

  fs.writeFileSync(
    path.join(stagingDir, "manifest.json"),
    `${JSON.stringify(
      {
        project: slug,
        tenantId,
        name: meta.name,
        backedUpAt: iso,
        scopeMdFromDb: meta.scopeMd,
        paths: {
          workspace: hadContent ? `workspace/${slug}` : null,
          macro: fs.existsSync(macroPath) ? `scopes/macro/${slug}.md` : null,
        },
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  try {
    zipDirectory(stagingDir, zipPath);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const relative = path.relative(tenantDataRoot(tenantId), zipPath).split(path.sep).join("/");

  return {
    backupDate: date,
    backupFile: zipFileName,
    backupPath: zipPath,
    backupRelative: relative,
    hadContent,
  };
}
