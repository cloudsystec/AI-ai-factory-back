import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetQueryOverrideForTests,
  __setQueryOverrideForTests,
} from "../db/pool.js";
import {
  __resetSpawnForTests,
  __setSpawnForTests,
  buildLocalWorkerStartCommand,
  resolveWorkerProvisionMode,
  writeTenantWorkerEnvFile,
  afterTenantCreated,
} from "./tenant-onboarding-service.js";

test("resolveWorkerProvisionMode — local por defeito em dev", () => {
  const prevMode = process.env.WORKER_PROVISION_MODE;
  const prevEnv = process.env.NODE_ENV;
  const prevToken = process.env.RAILWAY_API_TOKEN;
  delete process.env.WORKER_PROVISION_MODE;
  process.env.NODE_ENV = "development";
  delete process.env.RAILWAY_API_TOKEN;
  try {
    assert.equal(resolveWorkerProvisionMode(), "local");
  } finally {
    process.env.WORKER_PROVISION_MODE = prevMode;
    process.env.NODE_ENV = prevEnv;
    process.env.RAILWAY_API_TOKEN = prevToken;
  }
});

test("resolveWorkerProvisionMode — railway em production com vars", () => {
  const prev = {
    WORKER_PROVISION_MODE: process.env.WORKER_PROVISION_MODE,
    NODE_ENV: process.env.NODE_ENV,
    RAILWAY_API_TOKEN: process.env.RAILWAY_API_TOKEN,
    RAILWAY_PROJECT_ID: process.env.RAILWAY_PROJECT_ID,
    RAILWAY_ENVIRONMENT_ID: process.env.RAILWAY_ENVIRONMENT_ID,
    RAILWAY_CLI_TEMPLATE_SERVICE_ID: process.env.RAILWAY_CLI_TEMPLATE_SERVICE_ID,
  };
  delete process.env.WORKER_PROVISION_MODE;
  process.env.NODE_ENV = "production";
  process.env.RAILWAY_API_TOKEN = "token";
  process.env.RAILWAY_PROJECT_ID = "proj";
  process.env.RAILWAY_ENVIRONMENT_ID = "env";
  process.env.RAILWAY_CLI_TEMPLATE_SERVICE_ID = "svc";
  try {
    assert.equal(resolveWorkerProvisionMode(), "railway");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("resolveWorkerProvisionMode — WORKER_PROVISION_MODE=local força local", () => {
  const prev = {
    WORKER_PROVISION_MODE: process.env.WORKER_PROVISION_MODE,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.WORKER_PROVISION_MODE = "local";
  process.env.NODE_ENV = "production";
  try {
    assert.equal(resolveWorkerProvisionMode(), "local");
  } finally {
    process.env.WORKER_PROVISION_MODE = prev.WORKER_PROVISION_MODE;
    process.env.NODE_ENV = prev.NODE_ENV;
  }
});

test("buildLocalWorkerStartCommand inclui tenant id", () => {
  const cmd = buildLocalWorkerStartCommand("abc-123");
  assert.match(cmd, /abc-123/);
  if (process.platform === "win32") {
    assert.match(cmd, /start-tenant-worker\.ps1/);
    assert.match(cmd, /-Build/);
  } else {
    assert.match(cmd, /start-tenant-worker\.sh/);
    assert.match(cmd, /--build/);
  }
});

test("writeTenantWorkerEnvFile grava .env no volume do tenant", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-onboard-"));
  const tenantsDir = path.join(tmpRoot, "data", "tenants");
  fs.mkdirSync(tenantsDir, { recursive: true });
  const prevDir = process.env.TENANT_DATA_DIR;
  const prevBack = process.env.PUBLIC_BACK_URL;
  const prevWorkerBack = process.env.WORKER_BACK_URL;
  const prevRedis = process.env.REDIS_URL;
  const prevTenantRedis = process.env.TENANT_REDIS_URL;
  const prevRedisDocker = process.env.REDIS_URL_DOCKER;
  process.env.TENANT_DATA_DIR = tenantsDir;
  delete process.env.PUBLIC_BACK_URL;
  delete process.env.WORKER_BACK_URL;
  delete process.env.TENANT_REDIS_URL;
  delete process.env.REDIS_URL_DOCKER;
  process.env.REDIS_URL = "redis://127.0.0.1:6379";

  __setQueryOverrideForTests(async () => ({
    rows: [{ id: "t1", cursor_admin_api_key_encrypted: null }],
  }));

  try {
    const { envPath } = await writeTenantWorkerEnvFile("t1");
    assert.equal(path.basename(envPath), ".env");
    assert.ok(fs.existsSync(envPath));
    const content = fs.readFileSync(envPath, "utf8");
    assert.match(content, /TENANT_ID=t1/);
    assert.match(content, /BACK_URL=http:\/\/host\.docker\.internal:4000/);
    assert.match(content, /REDIS_URL=redis:\/\/host\.docker\.internal:6379/);
  } finally {
    __resetQueryOverrideForTests();
    process.env.TENANT_DATA_DIR = prevDir;
    process.env.PUBLIC_BACK_URL = prevBack;
    process.env.WORKER_BACK_URL = prevWorkerBack;
    process.env.REDIS_URL = prevRedis;
    process.env.TENANT_REDIS_URL = prevTenantRedis;
    process.env.REDIS_URL_DOCKER = prevRedisDocker;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("afterTenantCreated — local gera env e dispara spawn", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-onboard-"));
  const tenantsDir = path.join(tmpRoot, "data", "tenants");
  fs.mkdirSync(tenantsDir, { recursive: true });
  const prev = {
    WORKER_PROVISION_MODE: process.env.WORKER_PROVISION_MODE,
    NODE_ENV: process.env.NODE_ENV,
    TENANT_DATA_DIR: process.env.TENANT_DATA_DIR,
    PLATFORM_CURSOR_ADMIN_API_KEY: process.env.PLATFORM_CURSOR_ADMIN_API_KEY,
  };
  process.env.WORKER_PROVISION_MODE = "local";
  process.env.NODE_ENV = "development";
  process.env.TENANT_DATA_DIR = tenantsDir;
  delete process.env.PLATFORM_CURSOR_ADMIN_API_KEY;

  const scriptsDir = path.join(tmpRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(
      scriptsDir,
      process.platform === "win32" ? "start-tenant-worker.ps1" : "start-tenant-worker.sh"
    ),
    "# stub\n"
  );

  __setQueryOverrideForTests(async () => ({
    rows: [{ id: "t1", cursor_admin_api_key_encrypted: null }],
  }));

  let spawnCalled = false;
  __setSpawnForTests((executable, args, opts) => {
    spawnCalled = true;
    assert.ok(executable);
    assert.ok(Array.isArray(args));
    assert.equal(opts?.windowsHide, true);
    assert.notEqual(opts?.detached, true);
    const emitter = {
      stdout: { pipe() {} },
      stderr: { pipe() {} },
      on(event, cb) {
        if (event === "spawn") {
          setTimeout(() => cb(), 0);
        }
        return emitter;
      },
      unref() {},
    };
    return emitter;
  });

  const prevEarly = process.env.WORKER_START_EARLY_CHECK_MS;
  process.env.WORKER_START_EARLY_CHECK_MS = "10";

  try {
    const result = await afterTenantCreated("t1");
    assert.equal(result.mode, "local");
    assert.equal(result.started, true);
    assert.ok(result.envPath);
    assert.match(result.command, /t1/);
    assert.equal(spawnCalled, true);
  } finally {
    __resetQueryOverrideForTests();
    __resetSpawnForTests();
    if (prevEarly === undefined) delete process.env.WORKER_START_EARLY_CHECK_MS;
    else process.env.WORKER_START_EARLY_CHECK_MS = prevEarly;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
