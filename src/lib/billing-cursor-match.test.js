import test from "node:test";
import assert from "node:assert/strict";
import { pickBestCursorEvent } from "./billing-cursor-match.js";
import { cursorEventKey } from "./cursor-admin-api.js";

test("pickBestCursorEvent: entre elegíveis escolhe timestamp mais antigo", () => {
  const events = [
    { timestamp: "5010", chargedCents: 25, isChargeable: true },
    { timestamp: "4800", chargedCents: 10, isChargeable: true },
  ];
  const m = pickBestCursorEvent({
    startedMs: 1000,
    endedMs: 5000,
    events,
    maxMatchDeltaMs: 10_000,
  });
  assert.ok(m);
  assert.equal(m.eventTimestampMs, 4800);
  assert.equal(m.chargedCents, 10);
});

test("pickBestCursorEvent: aceita evento pouco depois de ended_at", () => {
  const events = [{ timestamp: "6000", chargedCents: 99, isChargeable: true }];
  const m = pickBestCursorEvent({
    startedMs: 1000,
    endedMs: 5000,
    events,
    maxMatchDeltaMs: 5000,
  });
  assert.ok(m);
  assert.equal(m.eventTimestampMs, 6000);
  assert.equal(m.matchDeltaMs, 1000);
});

test("pickBestCursorEvent: rejeita evento fora da tolerância", () => {
  const events = [{ timestamp: "6000", chargedCents: 99, isChargeable: true }];
  const m = pickBestCursorEvent({
    startedMs: 1000,
    endedMs: 5000,
    events,
    maxMatchDeltaMs: 500,
  });
  assert.equal(m, null);
});

test("pickBestCursorEvent: consumedKeys remove evento do pool", () => {
  const evOld = { id: "e1", timestamp: "4800", chargedCents: 10, isChargeable: true };
  const evNew = { id: "e2", timestamp: "4900", chargedCents: 20, isChargeable: true };
  const m = pickBestCursorEvent({
    startedMs: 1000,
    endedMs: 5000,
    events: [evOld, evNew],
    consumedKeys: new Set([cursorEventKey(evOld)]),
    maxMatchDeltaMs: 10_000,
  });
  assert.equal(m?.eventTimestampMs, 4900);
});

test("pickBestCursorEvent: filtra por email", () => {
  const events = [
    {
      timestamp: "4800",
      chargedCents: 10,
      isChargeable: true,
      userEmail: "bot@x.com",
    },
    {
      timestamp: "4900",
      chargedCents: 20,
      isChargeable: true,
      userEmail: "other@x.com",
    },
  ];
  const m = pickBestCursorEvent({
    startedMs: 1000,
    endedMs: 5000,
    events,
    email: "bot@x.com",
    maxMatchDeltaMs: 10_000,
  });
  assert.equal(m?.chargedCents, 10);
});
