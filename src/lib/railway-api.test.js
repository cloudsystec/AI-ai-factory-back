import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RAILWAY_CLI_BRANCH,
  DEFAULT_RAILWAY_CLI_REGION,
  DEFAULT_RAILWAY_CLI_REPO,
  isWorkerServiceConfigured,
  isWorkerServiceHealthy,
  isWorkerServiceNameValid,
  needsServiceInstanceCreate,
  railwayCliBranch,
  railwayCliRegion,
  railwayCliRepo,
  serviceInstanceHasRepo,
  toStagedVariableMap,
  workerServiceName,
  workerSkipsBuildOnProvision,
} from "./railway-api.js";

describe("railway-api CLI defaults", () => {
  it("defaults fixos sem ENV", () => {
    const prev = {
      RAILWAY_CLI_REPO: process.env.RAILWAY_CLI_REPO,
      RAILWAY_CLI_BRANCH: process.env.RAILWAY_CLI_BRANCH,
      RAILWAY_CLI_REGION: process.env.RAILWAY_CLI_REGION,
    };
    delete process.env.RAILWAY_CLI_REPO;
    delete process.env.RAILWAY_CLI_BRANCH;
    delete process.env.RAILWAY_CLI_REGION;
    try {
      assert.equal(railwayCliRepo(), DEFAULT_RAILWAY_CLI_REPO);
      assert.equal(railwayCliBranch(), DEFAULT_RAILWAY_CLI_BRANCH);
      assert.equal(railwayCliRegion(), DEFAULT_RAILWAY_CLI_REGION);
    } finally {
      if (prev.RAILWAY_CLI_REPO === undefined) delete process.env.RAILWAY_CLI_REPO;
      else process.env.RAILWAY_CLI_REPO = prev.RAILWAY_CLI_REPO;
      if (prev.RAILWAY_CLI_BRANCH === undefined) delete process.env.RAILWAY_CLI_BRANCH;
      else process.env.RAILWAY_CLI_BRANCH = prev.RAILWAY_CLI_BRANCH;
      if (prev.RAILWAY_CLI_REGION === undefined) delete process.env.RAILWAY_CLI_REGION;
      else process.env.RAILWAY_CLI_REGION = prev.RAILWAY_CLI_REGION;
    }
  });

  it("ENV sobrescreve defaults", () => {
    const prev = process.env.RAILWAY_CLI_REPO;
    process.env.RAILWAY_CLI_REPO = "other/repo";
    try {
      assert.equal(railwayCliRepo(), "other/repo");
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_CLI_REPO;
      else process.env.RAILWAY_CLI_REPO = prev;
    }
  });
});

describe("railway-api staged variables", () => {
  it("toStagedVariableMap formata value objects", () => {
    assert.deepEqual(toStagedVariableMap({ TENANT_ID: "abc", PORT: "80" }), {
      TENANT_ID: { value: "abc" },
      PORT: { value: "80" },
    });
  });
});

describe("railway-api service instance", () => {
  it("needsServiceInstanceCreate quando instância ausente", () => {
    assert.equal(needsServiceInstanceCreate(null), true);
    assert.equal(needsServiceInstanceCreate(undefined), true);
    assert.equal(needsServiceInstanceCreate({ region: "us-west1" }), false);
  });
});

describe("railway-api worker service name", () => {
  it("workerServiceName usa tenant UUID completo", () => {
    assert.equal(
      workerServiceName("bb6d9ded-c649-4134-b3c0-90a844a029b1"),
      "cli-bb6d9ded-c649-4134-b3c0-90a844a029b1"
    );
  });

  it("rejeita nome corrompido com UUIDs concatenados", () => {
    const tenantId = "bb6d9ded-c649-4134-b3c0-90a844a029b1";
    assert.equal(isWorkerServiceNameValid(workerServiceName(tenantId), tenantId), true);
    assert.equal(
      isWorkerServiceNameValid(
        "cli-bb6d9ded-45307d13-bb16-4a58-b9cf-e066d2dbe1d1",
        tenantId
      ),
      false
    );
  });
});

describe("railway-api worker health", () => {
  it("serviceInstanceHasRepo compara repo esperado", () => {
    assert.equal(
      serviceInstanceHasRepo(
        { source: { repo: "cloudsystec/AI-ai-factory-cli" } },
        DEFAULT_RAILWAY_CLI_REPO
      ),
      true
    );
    assert.equal(serviceInstanceHasRepo({ source: {} }), false);
    assert.equal(serviceInstanceHasRepo(null), false);
  });

  it("isWorkerServiceHealthy exige nome e repo", () => {
    const tenantId = "bb6d9ded-c649-4134-b3c0-90a844a029b1";
    const service = { id: "s1", name: workerServiceName(tenantId) };
    const instance = { source: { repo: DEFAULT_RAILWAY_CLI_REPO } };
    assert.equal(isWorkerServiceHealthy(service, instance, tenantId), true);
    assert.equal(
      isWorkerServiceConfigured(service, instance, tenantId),
      true
    );
    assert.equal(
      isWorkerServiceHealthy(
        { id: "s1", name: "cli-bb6d9ded-uuid-extra" },
        instance,
        tenantId
      ),
      false
    );
  });

  it("workerSkipsBuildOnProvision default true", () => {
    const prev = process.env.RAILWAY_WORKER_SKIP_BUILD;
    delete process.env.RAILWAY_WORKER_SKIP_BUILD;
    try {
      assert.equal(workerSkipsBuildOnProvision(), true);
      process.env.RAILWAY_WORKER_SKIP_BUILD = "false";
      assert.equal(workerSkipsBuildOnProvision(), false);
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_WORKER_SKIP_BUILD;
      else process.env.RAILWAY_WORKER_SKIP_BUILD = prev;
    }
  });
});
