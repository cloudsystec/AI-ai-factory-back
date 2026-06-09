import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isClientGitRepoMode,
  isManagedGitRepoMode,
  toPublicProjectGit,
  deriveProjectLifecycleStatus,
} from "./project-git-public.js";

describe("project-git-public", () => {
  it("isClientGitRepoMode", () => {
    assert.equal(isClientGitRepoMode("client"), true);
    assert.equal(isClientGitRepoMode("existing"), true);
    assert.equal(isClientGitRepoMode("managed"), false);
  });

  it("toPublicProjectGit oculta repo em managed", () => {
    const pub = toPublicProjectGit({
      slug: "p",
      name: "P",
      scope_md: "x",
      github_repo_mode: "managed",
      git_status: "ready",
      github_repo_full_name: "org/secret",
      github_default_branch: "main",
      github_tech_lead_branch: "tech-lead",
    });
    assert.equal(pub.repoFullName, null);
    assert.equal(pub.defaultBranch, null);
    assert.equal(pub.repoMode, "managed");
    assert.equal(pub.gitStatus, "ready");
  });

  it("toPublicProjectGit expõe repo em client", () => {
    const pub = toPublicProjectGit({
      slug: "p",
      name: "P",
      scope_md: "x",
      github_repo_mode: "client",
      git_status: "ready",
      github_repo_full_name: "org/repo",
      github_default_branch: "main",
      github_tech_lead_branch: "tech-lead",
    });
    assert.equal(pub.repoFullName, "org/repo");
  });

  it("isManagedGitRepoMode", () => {
    assert.equal(isManagedGitRepoMode("managed"), true);
    assert.equal(isManagedGitRepoMode("client"), false);
  });

  it("deriveProjectLifecycleStatus", () => {
    assert.equal(deriveProjectLifecycleStatus("completed", null), "completed");
    assert.equal(deriveProjectLifecycleStatus("active", null), "not_started");
    assert.equal(
      deriveProjectLifecycleStatus("active", { microCount: 0 }),
      "not_started"
    );
    assert.equal(
      deriveProjectLifecycleStatus("active", {
        microCount: 3,
        scopeSteps: [{ key: "macro", state: "done" }],
      }),
      "started"
    );
    assert.equal(
      deriveProjectLifecycleStatus("active", {
        microCount: 0,
        scopeSteps: [{ key: "macro", state: "done" }],
      }),
      "not_started"
    );
  });
});
