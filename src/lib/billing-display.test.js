import test from "node:test";
import assert from "node:assert/strict";
import { billingCallDisplayAt } from "./billing-display.js";

test("billingCallDisplayAt: prioriza cursor_matched_event_ms", () => {
  const iso = billingCallDisplayAt({
    cursor_matched_event_ms: 1_749_379_200_000,
    ended_at: "2026-06-01T18:00:00.000Z",
    started_at: "2026-06-01T17:00:00.000Z",
  });
  assert.equal(iso, new Date(1_749_379_200_000).toISOString());
});

test("billingCallDisplayAt: ended_at se sem match Cursor", () => {
  const ended = "2026-06-01T19:07:15.698Z";
  assert.equal(
    billingCallDisplayAt({ ended_at: ended, started_at: "2026-06-01T18:05:00.000Z" }),
    new Date(ended).toISOString()
  );
});
