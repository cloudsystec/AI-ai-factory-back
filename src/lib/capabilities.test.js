import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilities } from "./capabilities.js";

describe("buildCapabilities", () => {
  it("executor pode executar e escrever", () => {
    const c = buildCapabilities("executor", { usersUsed: 1, usersMax: 5 });
    assert.equal(c.canExecute, true);
    assert.equal(c.canWrite, true);
    assert.equal(c.canManageUsers, false);
    assert.equal(c.canAddUser, true);
  });

  it("auditor gere utilizadores", () => {
    const c = buildCapabilities("auditor", { usersUsed: 5, usersMax: 5 });
    assert.equal(c.canExecute, false);
    assert.equal(c.canWrite, true);
    assert.equal(c.canManageUsers, true);
    assert.equal(c.canAddUser, false);
  });

  it("visualizador só lê", () => {
    const c = buildCapabilities("viewer", { usersUsed: 0, usersMax: 5 });
    assert.equal(c.canExecute, false);
    assert.equal(c.canWrite, false);
    assert.equal(c.canManageUsers, false);
  });
});
