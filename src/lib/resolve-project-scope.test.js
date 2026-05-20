import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import { readMacroScopeFromDisk } from "./resolve-project-scope.js";

describe("readMacroScopeFromDisk", () => {
  /** @type {string|null} */
  let tmp = null;
  const tenantId = "test-tenant";

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.TENANT_DATA_DIR;
    tmp = null;
  });

  it("extrai título e corpo do macro", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aif-scope-"));
    process.env.TENANT_DATA_DIR = path.join(tmp, "tenants");
    const macroDir = path.join(tmp, "tenants", tenantId, "scopes", "macro");
    fs.mkdirSync(macroDir, { recursive: true });
    fs.writeFileSync(
      path.join(macroDir, "demo.md"),
      "# Demo App\n\ncriar API com swagger\n",
      "utf-8"
    );

    const r = readMacroScopeFromDisk(tenantId, "demo");
    assert.equal(r.name, "Demo App");
    assert.match(r.scopeMd, /swagger/);
  });
});
