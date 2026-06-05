import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { zipDirectory } from "../lib/project-backup.js";
import { log } from "../lib/logger.js";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import { getProjectGitRow, getProjectInstallationId } from "./project-git-service.js";
import { getProjectStatus } from "./project-completion-service.js";
import {
  downloadRepoZipballToFile,
  parseRepoFullName,
} from "./github-app-service.js";

const EXCLUDE_DIRS = new Set([
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
 * @param {string} zipPath
 */
function assertValidZipFile(zipPath) {
  const stat = fs.statSync(zipPath);
  if (!stat.isFile() || stat.size < 22) {
    throw Object.assign(new Error("ZIP inválido ou vazio."), {
      status: 500,
      code: "export_zip_invalid",
    });
  }
  const fd = fs.openSync(zipPath, "r");
  try {
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw Object.assign(new Error("Ficheiro gerado não é um ZIP válido."), {
        status: 500,
        code: "export_zip_invalid",
      });
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} dir
 */
function directoryHasFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isFile()) return true;
    if (ent.isDirectory() && directoryHasFiles(path.join(dir, ent.name))) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} srcDir
 * @param {string} destRoot
 */
function copyTreeFiltered(srcDir, destRoot) {
  if (!fs.existsSync(srcDir)) return;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    if (EXCLUDE_DIRS.has(ent.name)) continue;
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destRoot, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTreeFiltered(src, dest);
    } else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

/**
 * @param {string} cacheDir
 * @param {string} branch
 */
function resolveBareArchiveRef(cacheDir, branch) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const candidates = [
    branch,
    `refs/heads/${branch}`,
    `refs/remotes/origin/${branch}`,
    `origin/${branch}`,
  ];
  for (const ref of candidates) {
    const result = spawnSync(
      git,
      ["--git-dir", cacheDir, "rev-parse", "--verify", ref],
      { encoding: "utf-8", windowsHide: true }
    );
    if (result.status === 0) {
      return String(result.stdout || ref).trim();
    }
  }
  throw new Error(`Branch "${branch}" não encontrada no .git-cache`);
}

/**
 * @param {string} cacheDir
 * @param {string} branch
 * @param {string} zipPath
 */
function archiveBareRepoToZip(cacheDir, branch, zipPath) {
  const git = process.platform === "win32" ? "git.exe" : "git";
  const ref = resolveBareArchiveRef(cacheDir, branch);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const result = spawnSync(
    git,
    ["--git-dir", cacheDir, "archive", "--format=zip", "-o", zipPath, ref],
    { encoding: "utf-8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `git archive: ${result.stderr || result.stdout || result.status}`
    );
  }
  assertValidZipFile(zipPath);
}

/**
 * @param {string} branch
 * @param {string} token
 * @param {string} repoFullName
 */
function checkoutFromGitHub(branch, token, repoFullName) {
  const staging = path.join(tmpdir(), `aif-export-${randomUUID()}`);
  const checkout = path.join(staging, "src");
  fs.mkdirSync(checkout, { recursive: true });
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  const git = process.platform === "win32" ? "git.exe" : "git";
  const clone = spawnSync(
    git,
    ["clone", "--depth", "1", "--branch", branch, remoteUrl, checkout],
    { encoding: "utf-8", windowsHide: true }
  );
  if (clone.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`git clone: ${clone.stderr || clone.stdout || clone.status}`);
  }
  return { staging, checkout };
}

/**
 * @param {string} sourceDir
 * @param {string} staging
 * @param {string} slug
 */
function zipFilteredWorkspace(sourceDir, staging, slug) {
  const filtered = path.join(staging, "filtered");
  fs.mkdirSync(filtered, { recursive: true });
  copyTreeFiltered(sourceDir, filtered);
  if (!directoryHasFiles(filtered)) {
    throw Object.assign(
      new Error("Não há ficheiros de código para exportar."),
      { status: 404, code: "export_empty" }
    );
  }
  const zipPath = path.join(staging, `${slug}-code.zip`);
  zipDirectory(filtered, zipPath);
  assertValidZipFile(zipPath);
  return zipPath;
}

/**
 * Exporta código do projecto finalizado.
 * Prioridade: zipball GitHub → git archive (.git-cache) → clone + zip local.
 * @param {string} tenantId
 * @param {string} slug
 */
export async function exportProjectCodeZip(tenantId, slug) {
  const status = await getProjectStatus(tenantId, slug);
  if (status.status !== "completed") {
    throw Object.assign(
      new Error("Download disponível apenas para projetos finalizados."),
      { status: 403, code: "project_not_completed" }
    );
  }

  const row = await getProjectGitRow(tenantId, slug);
  if (!row) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
  if (!row.github_repo_full_name) {
    throw Object.assign(
      new Error("Projeto sem repositório Git — nada para exportar."),
      { status: 404, code: "export_unavailable" }
    );
  }
  if (!parseRepoFullName(row.github_repo_full_name)) {
    throw Object.assign(new Error("Repositório Git inválido."), {
      status: 500,
      code: "export_unavailable",
    });
  }

  const exportBranch = row.github_tech_lead_branch || "tech-lead";
  const staging = path.join(tmpdir(), `aif-export-${randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true });
  const zipPath = path.join(staging, `${slug}-code.zip`);
  const errors = [];

  const installationId = await getProjectInstallationId(tenantId, slug);
  if (installationId) {
    try {
      await downloadRepoZipballToFile(
        installationId,
        row.github_repo_full_name,
        exportBranch,
        zipPath
      );
      assertValidZipFile(zipPath);
      log.info("Export ZIP via GitHub zipball", {
        project: slug,
        branch: exportBranch,
        repo: row.github_repo_full_name,
      });
      return {
        zipPath,
        fileName: `${slug}-code.zip`,
        cleanup: () => fs.rmSync(staging, { recursive: true, force: true }),
      };
    } catch (e) {
      errors.push(`zipball: ${e.message}`);
      log.warn("Export zipball falhou", { project: slug, error: e.message });
    }
  } else {
    errors.push("zipball: installation_id em falta");
  }

  const cacheDir = path.join(tenantWorkspacesDir(tenantId), slug, ".git-cache");
  if (fs.existsSync(cacheDir)) {
    try {
      archiveBareRepoToZip(cacheDir, exportBranch, zipPath);
      log.info("Export ZIP via git archive", { project: slug, branch: exportBranch });
      return {
        zipPath,
        fileName: `${slug}-code.zip`,
        cleanup: () => fs.rmSync(staging, { recursive: true, force: true }),
      };
    } catch (e) {
      errors.push(`archive: ${e.message}`);
      log.warn("Export git archive falhou", { project: slug, error: e.message });
    }
  } else {
    errors.push("archive: .git-cache ausente");
  }

  if (!installationId) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw Object.assign(
      new Error("Token GitHub indisponível para exportação."),
      { status: 503, code: "github_token_missing" }
    );
  }

  let extraStaging = null;
  try {
    const { getInstallationAccessToken } = await import("./github-app-service.js");
    const { token } = await getInstallationAccessToken(installationId);
    extraStaging = checkoutFromGitHub(
      exportBranch,
      token,
      row.github_repo_full_name
    );
    const finalZip = zipFilteredWorkspace(extraStaging.checkout, staging, slug);
    log.info("Export ZIP via git clone", { project: slug, branch: exportBranch });
    return {
      zipPath: finalZip,
      fileName: `${slug}-code.zip`,
      cleanup: () => {
        if (extraStaging) {
          fs.rmSync(extraStaging.staging, { recursive: true, force: true });
        }
        fs.rmSync(staging, { recursive: true, force: true });
      },
    };
  } catch (e) {
    errors.push(`clone: ${e.message}`);
    if (extraStaging) {
      fs.rmSync(extraStaging.staging, { recursive: true, force: true });
    }
    fs.rmSync(staging, { recursive: true, force: true });
    log.error("Export ZIP falhou", { project: slug, attempts: errors });
    throw Object.assign(
      new Error(
        `Não foi possível exportar o código (${exportBranch}). ${errors.join("; ")}`
      ),
      { status: 502, code: "export_failed" }
    );
  }
}
