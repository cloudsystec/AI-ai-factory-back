import test from "node:test";
import assert from "node:assert/strict";
import * as mod from "./billing-call-service.js";

test("billing-call-service exports", () => {
  assert.equal(typeof mod.insertClaimsForCall, "function");
  assert.equal(typeof mod.registerAiCall, "function");
  assert.equal(typeof mod.reconcileJobCalls, "function");
  assert.equal(typeof mod.loadConsumedKeys, "function");
  assert.equal(typeof mod.listJobBillingCalls, "function");
  assert.equal(typeof mod.endAiCall, "function");
  assert.equal(typeof mod.sumJobBillingCalls, "function");
  assert.equal(typeof mod.listCallsAwaitingCursorSettle, "function");
  assert.equal(typeof mod.applyCursorMatchToCall, "function");
  assert.equal(typeof mod.billingCallAnchorMs, "function");
});

test("billingCallAnchorMs prefere ended_at", () => {
  const ended = new Date("2026-05-30T12:00:00Z");
  const started = new Date("2026-05-30T11:00:00Z");
  assert.equal(
    mod.billingCallAnchorMs(started, ended),
    ended.getTime()
  );
  assert.equal(
    mod.billingCallAnchorMs(started, null),
    started.getTime()
  );
});
