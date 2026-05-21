import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLiveTasks, readLiveTaskDetail } from "./workspace-dashboard-reader.js";

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("readLiveTasks: lê backlog aprovado do workspace", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aif-ws-read-"));
  const tenantRoot = path.join(base, TENANT);
  const slug = "live-read-proj";
  const ws = path.join(tenantRoot, "workspaces", slug);
  fs.mkdirSync(path.join(ws, "backlog"), { recursive: true });
  fs.writeFileSync(path.join(ws, "tasks-state.json"), "[]\n", "utf-8");
  fs.writeFileSync(
    path.join(ws, "backlog", `${slug}.tasks.json`),
    JSON.stringify({
      project: slug,
      macroId: slug,
      tasks: [
        {
          id: `${slug}-t01`,
          project: slug,
          title: "From disk",
          status: "todo",
          validationStatus: "approved",
        },
      ],
    }),
    "utf-8"
  );
  fs.mkdirSync(path.join(tenantRoot, "scopes", "macro"), { recursive: true });
  fs.writeFileSync(
    path.join(tenantRoot, "scopes", "macro", `${slug}.md`),
    "# test\n",
    "utf-8"
  );

  const prev = process.env.TENANT_DATA_DIR;
  process.env.TENANT_DATA_DIR = base;
  t.after(() => {
    if (prev === undefined) delete process.env.TENANT_DATA_DIR;
    else process.env.TENANT_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const live = await readLiveTasks(TENANT, slug);
  assert.equal(live.ok, true);
  if (live.ok) {
    assert.ok(live.tasks.some((x) => x.id === `${slug}-t01`));
  }

  const detail = await readLiveTaskDetail(TENANT, slug, `${slug}-t01`);
  assert.equal(detail.ok, true);
  if (detail.ok && detail.detail) {
    assert.equal(detail.detail.taskId, `${slug}-t01`);
    assert.equal(detail.detail.backlog?.title, "From disk");
  }
});
