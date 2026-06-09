import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeployRepoName,
  buildRailwayProjectName,
} from "./deploy-git-service.js";

describe("deploy-git-service naming", () => {
  const tenantId = "a1111111-1111-4111-8111-111111111111";
  const slug = "food-delivery";

  it("buildDeployRepoName uses deploy prefix", () => {
    const name = buildDeployRepoName(tenantId, slug);
    assert.match(name, /^df-deploy-a1111111-food-delivery$/);
  });

  it("buildRailwayProjectName uses client prefix", () => {
    const name = buildRailwayProjectName(tenantId, slug);
    assert.match(name, /^df-a1111111-food-delivery$/);
  });
});
