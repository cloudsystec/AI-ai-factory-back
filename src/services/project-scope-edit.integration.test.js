import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetQueryOverrideForTests,
  __setQueryOverrideForTests,
} from "../db/pool.js";
import {
  updateTaskFields,
  updateMicroAndRegenerateTasks,
  getEditabilityReport,
} from "./project-scope-edit-service.js";

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SLUG = "copilot-int";

function setupWorkspace(base) {
  const ws = path.join(base, TENANT, "workspaces", SLUG);
  fs.mkdirSync(path.join(ws, "backlog"), { recursive: true });
  fs.mkdirSync(path.join(ws, "scopes", "micro"), { recursive: true });
  fs.writeFileSync(path.join(ws, "tasks-state.json"), "[]\n", "utf-8");
  fs.writeFileSync(
    path.join(ws, "backlog", `${SLUG}.tasks.json`),
    JSON.stringify({
      project: SLUG,
      macroId: SLUG,
      tasks: [
        {
          id: "T1",
          project: SLUG,
          sourceMicroId: "M1",
          title: "Original",
          status: "todo",
          approved: true,
          description: "desc",
        },
      ],
    }),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(ws, "scopes", "micro", `${SLUG}.micro.json`),
    JSON.stringify([
      {
        id: "M1",
        project: SLUG,
        macroId: SLUG,
        title: "Micro 1",
        description: "d",
        approved: true,
        validationStatus: "approved",
        priority: 1,
        taskDeliveryStatus: "open",
        wavePhase: "open",
      },
    ]),
    "utf-8"
  );
  fs.mkdirSync(path.join(base, TENANT, "scopes", "macro"), { recursive: true });
  fs.writeFileSync(
    path.join(base, TENANT, "scopes", "macro", `${SLUG}.md`),
    "# test\n",
    "utf-8"
  );
}

test("updateTaskFields altera backlog no disco", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aif-int-task-"));
  setupWorkspace(base);
  const prev = process.env.TENANT_DATA_DIR;
  process.env.TENANT_DATA_DIR = base;

  __setQueryOverrideForTests(async (text) => {
    if (/status, completed_at FROM projects/i.test(text)) {
      return { rows: [{ status: "active", completed_at: null }] };
    }
    if (/FROM projects WHERE tenant_id/i.test(text)) {
      return { rows: [{ slug: SLUG, name: "Test", status: "active" }] };
    }
    if (/FROM jobs j/i.test(text) && /task_id/i.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  t.after(() => {
    __resetQueryOverrideForTests();
    if (prev === undefined) delete process.env.TENANT_DATA_DIR;
    else process.env.TENANT_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const out = await updateTaskFields(TENANT, SLUG, "T1", { title: "Atualizado" });
  assert.equal(out.task.title, "Atualizado");

  const raw = JSON.parse(
    fs.readFileSync(
      path.join(base, TENANT, "workspaces", SLUG, "backlog", `${SLUG}.tasks.json`),
      "utf-8"
    )
  );
  assert.equal(raw.tasks[0].title, "Atualizado");
});

test("getEditabilityReport marca task editável", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aif-int-rep-"));
  setupWorkspace(base);
  const prev = process.env.TENANT_DATA_DIR;
  process.env.TENANT_DATA_DIR = base;

  __setQueryOverrideForTests(async (text) => {
    if (/FROM projects WHERE tenant_id/i.test(text)) {
      return { rows: [{ slug: SLUG }] };
    }
    if (/FROM micro_releases/i.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  t.after(() => {
    __resetQueryOverrideForTests();
    if (prev === undefined) delete process.env.TENANT_DATA_DIR;
    else process.env.TENANT_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const report = await getEditabilityReport(TENANT, SLUG);
  assert.equal(report.editableTaskCount, 1);
  assert.equal(report.micros[0].editable, true);
});

test("updateMicroAndRegenerateTasks remove tasks e enfileira job", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aif-int-micro-"));
  setupWorkspace(base);
  const prev = process.env.TENANT_DATA_DIR;
  process.env.TENANT_DATA_DIR = base;
  const insertedJobs = [];

  __setQueryOverrideForTests(async (text, params) => {
    if (/git_status, git_last_error FROM projects/i.test(text)) {
      return { rows: [{ git_status: "ready", git_last_error: null }] };
    }
    if (/status, completed_at FROM projects/i.test(text)) {
      return { rows: [{ status: "active", completed_at: null }] };
    }
    if (/FROM projects WHERE tenant_id/i.test(text)) {
      return { rows: [{ slug: SLUG, name: "Test", status: "active" }] };
    }
    if (/FROM micro_releases/i.test(text)) {
      return { rows: [] };
    }
    if (/FROM jobs/i.test(text) && /scope/i.test(text)) {
      return { rows: [] };
    }
    if (/FROM tenants WHERE id/i.test(text)) {
      return {
        rows: [
          {
            balance_usd: 100,
            has_active_job: false,
            agent_slots_max: 5,
            agent_slots_in_use: 0,
          },
        ],
      };
    }
    if (/INSERT INTO jobs/i.test(text)) {
      insertedJobs.push(params);
      return { rows: [] };
    }
    if (/project_dashboard_snapshots/i.test(text)) {
      return { rows: [] };
    }
    if (/projects SET planned_cost/i.test(text)) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  t.after(() => {
    __resetQueryOverrideForTests();
    if (prev === undefined) delete process.env.TENANT_DATA_DIR;
    else process.env.TENANT_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const out = await updateMicroAndRegenerateTasks(
    TENANT,
    SLUG,
    "M1",
    { description: "Micro refinado" },
    "incluir testes E2E",
    "user-1"
  );

  assert.equal(out.removedTaskCount, 1);
  assert.ok(out.jobId);
  assert.equal(insertedJobs.length, 1);

  const backlog = JSON.parse(
    fs.readFileSync(
      path.join(base, TENANT, "workspaces", SLUG, "backlog", `${SLUG}.tasks.json`),
      "utf-8"
    )
  );
  assert.equal(backlog.tasks.length, 0);

  const micros = JSON.parse(
    fs.readFileSync(
      path.join(
        base,
        TENANT,
        "workspaces",
        SLUG,
        "scopes",
        "micro",
        `${SLUG}.micro.json`
      ),
      "utf-8"
    )
  );
  assert.equal(micros[0].description, "Micro refinado");
});
