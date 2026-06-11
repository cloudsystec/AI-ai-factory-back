import test from "node:test";
import assert from "node:assert/strict";
import {
  isTaskDevelopmentStarted,
  isTaskEditable,
  isMicroEditable,
  getTaskEditBlockReason,
} from "./project-scope-edit-service.js";

test("isTaskEditable: todo aprovado sem runtime", () => {
  const task = { id: "T1", status: "todo", approved: true };
  assert.equal(isTaskEditable(task, undefined), true);
});

test("isTaskEditable: rejeita pending_validation", () => {
  const task = { id: "T1", status: "pending_validation", approved: false };
  assert.equal(isTaskEditable(task, undefined), false);
  const block = getTaskEditBlockReason(task, undefined);
  assert.equal(block?.code, "TASK_NOT_IN_TODO");
});

test("isTaskEditable: rejeita dev iniciado", () => {
  const task = { id: "T1", status: "todo", approved: true };
  const runtime = { id: "T1", status: "development" };
  assert.equal(isTaskEditable(task, runtime), false);
  assert.equal(isTaskDevelopmentStarted(task, runtime), true);
  const block = getTaskEditBlockReason(task, runtime);
  assert.equal(block?.code, "TASK_DEV_STARTED");
});

test("isTaskEditable: rejeita todo não aprovado", () => {
  const task = { id: "T1", status: "todo", approved: false };
  const block = getTaskEditBlockReason(task, undefined);
  assert.equal(block?.code, "TASK_NOT_APPROVED");
});

test("isMicroEditable: todas sem dev", () => {
  const tasks = [
    { id: "T1", status: "todo", approved: true },
    { id: "T2", status: "todo", approved: true },
  ];
  const map = new Map();
  assert.equal(isMicroEditable(tasks, map), true);
});

test("isMicroEditable: bloqueia se uma task em planning", () => {
  const tasks = [
    { id: "T1", status: "todo", approved: true },
    { id: "T2", status: "todo", approved: true },
  ];
  const map = new Map([["T2", { status: "planning" }]]);
  assert.equal(isMicroEditable(tasks, map), false);
});

test("isTaskDevelopmentStarted: lastCompletedStep", () => {
  const task = { id: "T1", status: "todo", approved: true };
  assert.equal(
    isTaskDevelopmentStarted(task, { lastCompletedStep: "dev" }),
    true
  );
});
