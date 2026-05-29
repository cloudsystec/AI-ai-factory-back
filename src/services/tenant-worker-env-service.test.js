import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatTenantWorkerEnvLines } from "./tenant-worker-env-service.js";

describe("tenant-worker-env-service", () => {
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
