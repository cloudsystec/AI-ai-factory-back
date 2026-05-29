import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RAILWAY_CLI_BRANCH,
  DEFAULT_RAILWAY_CLI_REGION,
  DEFAULT_RAILWAY_CLI_REPO,
  buildInstanceInputFromEnv,
  buildInstanceInputFromTemplate,
  railwayCliBranch,
  railwayCliRegion,
  railwayCliRepo,
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
      const input = buildInstanceInputFromEnv();
      assert.deepEqual(input.source, {
        repo: DEFAULT_RAILWAY_CLI_REPO,
        branch: DEFAULT_RAILWAY_CLI_BRANCH,
      });
      assert.equal(input.region, DEFAULT_RAILWAY_CLI_REGION);
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

describe("railway-api buildInstanceInputFromTemplate", () => {
  it("usa defaults quando template vazio", () => {
    const input = buildInstanceInputFromTemplate({
      instance: null,
      service: null,
    });
    assert.equal(input.source.repo, DEFAULT_RAILWAY_CLI_REPO);
  });

  it("buildInstanceInputFromEnv com Dockerfile", () => {
    const prev = process.env.RAILWAY_CLI_DOCKERFILE_PATH;
    process.env.RAILWAY_CLI_DOCKERFILE_PATH = "Dockerfile";
    try {
      const input = buildInstanceInputFromEnv();
      assert.equal(input.dockerfilePath, "Dockerfile");
      assert.equal(input.builder, "DOCKERFILE");
    } finally {
      if (prev === undefined) delete process.env.RAILWAY_CLI_DOCKERFILE_PATH;
      else process.env.RAILWAY_CLI_DOCKERFILE_PATH = prev;
    }
  });
});
