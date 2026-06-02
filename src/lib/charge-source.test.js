import test from "node:test";
import assert from "node:assert/strict";
import {
  isChargeConfirmed,
  aggregateJobChargeSource,
  resolveJobChargeSource,
} from "./charge-source.js";

test("isChargeConfirmed", () => {
  assert.equal(isChargeConfirmed("cursor_admin_api"), true);
  assert.equal(isChargeConfirmed("estimate"), false);
  assert.equal(isChargeConfirmed("token_preview"), false);
  assert.equal(isChargeConfirmed("fee_minimum"), false);
  assert.equal(isChargeConfirmed("pending"), false);
  // 1 cent real da Cursor continua confirmado se source for cursor_admin_api
  assert.equal(isChargeConfirmed("cursor_admin_api"), true);
});

test("resolveJobChargeSource nunca infere pelo valor USD", () => {
  assert.equal(
    resolveJobChargeSource({ costBaseUsd: 0.01, chargeSource: "cursor_admin_api" }),
    "cursor_admin_api"
  );
  assert.equal(
    resolveJobChargeSource({ costBaseUsd: 0.01 }),
    "estimate"
  );
  assert.equal(
    resolveJobChargeSource({ costBaseUsd: 0, chargeSource: "pending" }),
    "pending"
  );
  assert.equal(resolveJobChargeSource({ costBaseUsd: 0 }), "fee_minimum");
  assert.equal(resolveJobChargeSource({ costBaseUsd: null }), "estimate_default");
});

test("aggregateJobChargeSource", () => {
  assert.equal(
    aggregateJobChargeSource(["cursor_admin_api", "cursor_admin_api"]),
    "cursor_admin_api"
  );
  assert.equal(
    aggregateJobChargeSource(["cursor_admin_api", "pending"]),
    "pending"
  );
  assert.equal(
    aggregateJobChargeSource(["estimate_reconcile"]),
    "estimate_reconcile"
  );
});
