import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRollover,
  canStartJob,
  computeCharge,
  computeTokenFee,
} from "./index.js";

test("computeTokenFee", () => {
  assert.equal(computeTokenFee(1), 0.15);
  assert.equal(computeTokenFee(0), 0.01);
});

test("computeCharge completed", () => {
  const r = computeCharge(10, "succeeded");
  assert.equal(r.debitCb, true);
  assert.ok(r.cc > 10);
});

test("computeCharge cancelled", () => {
  const r = computeCharge(10, "cancelled");
  assert.equal(r.debitCb, false);
});

test("applyRollover", () => {
  const r = applyRollover(100, 50);
  assert.equal(r.effective, 20);
  assert.equal(r.expired, 30);
});

test("canStartJob", () => {
  assert.equal(canStartJob(1, false).allowed, true);
  assert.equal(canStartJob(0, true).allowed, true);
  assert.equal(canStartJob(0, false).allowed, false);
});
