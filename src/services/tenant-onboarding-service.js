import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { query } from "../db/pool.js";
import { createLogger } from "../lib/logger.js";
import { railwayConfig } from "../lib/railway-api.js";
import { ensureTenantDirs, tenantCliRoot, tenantDataRoot } from "../lib/tenant-paths.js";
import { setTenantCursorAdminKey } from "./tenant-service.js";
import {
  applyLocalDockerWorkerEnvDefaults,
  buildTenantWorkerEnv,
  formatTenantWorkerEnvLines,
} from "./tenant-worker-env-service.js";
import { enqueueWorkerProvision } from "./worker-deployment-service.js";

const log = createLogger("tenant-onboarding");

/** @type {typeof nodeSpawn} */
let spawnImpl = nodeSpawn;

export function __setSpawnForTests(fn) {
  spawnImpl = fn;
}

export function __resetSpawnForTests() {
  spawnImpl = nodeSpawn;
}

export function isRailwayWorkerProvisionConfigured() {
  const cfg = railwayConfig();
  return Boolean(
    cfg.apiToken && cfg.projectId && cfg.environmentId && cfg.templateServiceId
  );
}

/**
 * @returns {'railway'|'local'}
 */
export function resolveWorkerProvisionMode() {
  const explicit = String(process.env.WORKER_PROVISION_MODE || "")
    .trim()
    .toLowerCase();
  if (explicit === "local") return "local";
  if (explicit === "railway") return "railway";
  if (process.env.NODE_ENV === "production" && isRailwayWorkerProvisionConfigured()) {
    return "railway";
  }
  return "local";
}

export function resolveCliRoot() {
  return tenantCliRoot();
}

export function resolveCliScriptsDir() {
  return path.join(resolveCliRoot(), "scripts");
}

/**
 * Comando relativo à raiz do repo ai-factory-cli (para exibir ao operador).
 * @param {string} tenantId
 */
export function buildLocalWorkerStartCommand(tenantId) {
  if (process.platform === "win32") {
    return `.\\scripts\\start-tenant-worker.ps1 ${tenantId} -Build`;
  }
  return `./scripts/start-tenant-worker.sh ${tenantId} --build`;
}

/**
 * @param {string} tenantId
 */
export async function applyPlatformCursorAdminKeyIfNeeded(tenantId) {
  const platformKey = String(process.env.PLATFORM_CURSOR_ADMIN_API_KEY || "").trim();
  if (!platformKey) return;
  const { rows } = await query(
    "SELECT cursor_admin_api_key_encrypted FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (rows[0]?.cursor_admin_api_key_encrypted) return;
  await setTenantCursorAdminKey(tenantId, platformKey);
}

/**
 * @param {string} tenantId
 */
export async function writeTenantWorkerEnvFile(tenantId) {
  const env = applyLocalDockerWorkerEnvDefaults(await buildTenantWorkerEnv(tenantId));
  ensureTenantDirs(tenantId);
  const envPath = path.join(tenantDataRoot(tenantId), ".env");
  fs.writeFileSync(
    envPath,
    `${formatTenantWorkerEnvLines(env).join("\n")}\n`,
    "utf-8"
  );
  return { envPath };
}

/**
 * @param {string} logPath
 * @param {number} [maxChars]
 */
function readLogTail(logPath, maxChars = 1200) {
  try {
    if (!fs.existsSync(logPath)) return "";
    const text = fs.readFileSync(logPath, "utf8");
    return text.slice(-maxChars).trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} tenantId
 * @returns {Promise<{ started: boolean, command: string, error?: string, logPath?: string, pending?: boolean }>}
 */
export async function startLocalWorkerDocker(tenantId) {
  const cliRoot = resolveCliRoot();
  const command = buildLocalWorkerStartCommand(tenantId);
  const scriptPath =
    process.platform === "win32"
      ? path.join(cliRoot, "scripts", "start-tenant-worker.ps1")
      : path.join(cliRoot, "scripts", "start-tenant-worker.sh");

  if (!fs.existsSync(scriptPath)) {
    const error = `Script worker não encontrado: ${scriptPath}`;
    log.error(error, { tenantId: tenantId.slice(0, 8) });
    return { started: false, command, error };
  }

  ensureTenantDirs(tenantId);
  const logPath = path.join(tenantDataRoot(tenantId), "worker-start.log");
  fs.appendFileSync(logPath, `\n--- ${new Date().toISOString()} ---\n`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          tenantId,
          "-Build",
        ]
      : [scriptPath, tenantId, "--build"];

  const executable = process.platform === "win32" ? "powershell.exe" : "bash";
  const earlyCheckMs = Number(process.env.WORKER_START_EARLY_CHECK_MS || 4000);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawnImpl(executable, args, {
      cwd: cliRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    child.on("error", (err) => {
      logStream.end();
      log.error("Falha ao iniciar worker Docker local", {
        tenantId: tenantId.slice(0, 8),
        error: err.message,
      });
      finish({ started: false, command, error: err.message, logPath });
    });

    child.on("close", (code) => {
      logStream.end();
      if (settled) return;
      if (code === 0) {
        log.info("Worker Docker local concluído", {
          tenantId: tenantId.slice(0, 8),
          logPath,
        });
        finish({ started: true, command, logPath });
        return;
      }
      const tail = readLogTail(logPath);
      finish({
        started: false,
        command,
        logPath,
        error: `Script worker saiu com código ${code}${tail ? `: ${tail}` : ""}`,
      });
    });

    child.on("spawn", () => {
      setTimeout(() => {
        if (settled) return;
        child.unref();
        log.info("Worker Docker local em execução (background)", {
          tenantId: tenantId.slice(0, 8),
          command,
          logPath,
        });
        finish({ started: true, command, logPath, pending: true });
      }, earlyCheckMs);
    });
  });
}

/**
 * Pós-criação de tenant: Cursor admin key + provisionamento worker (Railway ou Docker local).
 * @param {string} tenantId
 */
export async function afterTenantCreated(tenantId) {
  await applyPlatformCursorAdminKeyIfNeeded(tenantId);
  const mode = resolveWorkerProvisionMode();

  if (mode === "railway") {
    enqueueWorkerProvision(tenantId);
    return { mode: "railway", status: "enqueued" };
  }

  let envPath;
  try {
    ({ envPath } = await writeTenantWorkerEnvFile(tenantId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error("Falha ao gerar .env do worker local", {
      tenantId: tenantId.slice(0, 8),
      error: message,
    });
    return {
      mode: "local",
      envPath: null,
      command: buildLocalWorkerStartCommand(tenantId),
      started: false,
      error: message,
    };
  }

  const docker = await startLocalWorkerDocker(tenantId);
  return {
    mode: "local",
    envPath,
    command: docker.command,
    started: docker.started,
    pending: docker.pending === true,
    logPath: docker.logPath,
    error: docker.error,
  };
}
