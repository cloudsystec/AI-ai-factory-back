import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
});
