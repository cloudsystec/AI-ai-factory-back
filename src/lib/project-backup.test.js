import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, afterEach } from "node:test";
import { zipDirectory } from "./project-backup.js";

describe("zipDirectory", () => {
  /** @type {string|null} */
  let tmp = null;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("cria ficheiro zip não vazio", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aif-backup-"));
    const src = path.join(tmp, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "hello.txt"), "ok", "utf-8");
    const zipPath = path.join(tmp, "out.zip");
    zipDirectory(src, zipPath);
    assert.ok(fs.existsSync(zipPath));
    assert.ok(fs.statSync(zipPath).size > 0);
  });
});
