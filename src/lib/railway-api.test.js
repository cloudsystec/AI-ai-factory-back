import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInstanceInputFromTemplate } from "./railway-api.js";

describe("railway-api buildInstanceInputFromTemplate", () => {
  it("copia repo do template", () => {
    const input = buildInstanceInputFromTemplate({
      instance: {
        region: "us-west1",
        builder: "DOCKERFILE",
        dockerfilePath: "Dockerfile",
        source: { repo: "org/ai-factory-cli", branch: "main" },
      },
      service: { rootDirectory: "ai-factory-cli" },
    });
    assert.equal(input.isCreated, true);
    assert.equal(input.region, "us-west1");
    assert.deepEqual(input.source, {
      repo: "org/ai-factory-cli",
      branch: "main",
    });
    assert.equal(input.rootDirectory, "ai-factory-cli");
  });

  it("usa RAILWAY_CLI_REPO como fallback", () => {
    const prev = process.env.RAILWAY_CLI_REPO;
    process.env.RAILWAY_CLI_REPO = "org/cli-repo";
    try {
      const input = buildInstanceInputFromTemplate({
        instance: null,
        service: null,
      });
      assert.deepEqual(input.source, {
        repo: "org/cli-repo",
        branch: "main",
      });
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_CLI_REPO;
      else process.env.RAILWAY_CLI_REPO = prev;
    }
  });
});
