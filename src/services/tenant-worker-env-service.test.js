import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLocalDockerWorkerEnvDefaults,
  formatTenantWorkerEnvLines,
  resolveWorkerBackUrl,
} from "./tenant-worker-env-service.js";

describe("tenant-worker-env-service", () => {
  it("WORKER_BACK_URL tem prioridade sobre PUBLIC_BACK_URL", () => {
    const prevWorker = process.env.WORKER_BACK_URL;
    const prevPublic = process.env.PUBLIC_BACK_URL;
    process.env.WORKER_BACK_URL = "http://back.railway.internal:4000/";
    process.env.PUBLIC_BACK_URL = "https://public.example.com";
    try {
      assert.equal(
        resolveWorkerBackUrl(),
        "http://back.railway.internal:4000"
      );
    } finally {
      if (prevWorker === undefined) delete process.env.WORKER_BACK_URL;
      else process.env.WORKER_BACK_URL = prevWorker;
      if (prevPublic === undefined) delete process.env.PUBLIC_BACK_URL;
      else process.env.PUBLIC_BACK_URL = prevPublic;
    }
  });

  it("formatTenantWorkerEnvLines gera linhas KEY=value", () => {
    const lines = formatTenantWorkerEnvLines({
      TENANT_ID: "abc",
      BACK_URL: "https://api.test",
    });
    assert.deepEqual(lines, [
      "TENANT_ID=abc",
      "BACK_URL=https://api.test",
    ]);
  });

  it("applyLocalDockerWorkerEnvDefaults usa host.docker.internal", () => {
    const env = applyLocalDockerWorkerEnvDefaults({
      TENANT_ID: "t1",
      BACK_URL: "",
      REDIS_URL: "redis://127.0.0.1:6379",
      WORKER_SECRET: "secret",
    });
    assert.equal(env.BACK_URL, "http://host.docker.internal:4000");
    assert.equal(env.REDIS_URL, "redis://host.docker.internal:6379");
  });
});
