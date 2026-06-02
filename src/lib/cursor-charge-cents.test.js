import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCursorChargeToCents,
  cursorChargedFieldToCostBaseUsd,
} from "./cursor-charge-cents.js";
import { chargedCentsToCostBaseUsd } from "./billing-cursor-match.js";

test("cursorChargedFieldToCostBaseUsd: centavos de USD da API", () => {
  assert.equal(cursorChargedFieldToCostBaseUsd(66.12), 0.6612);
  assert.equal(cursorChargedFieldToCostBaseUsd(18.8993), 0.188993);
  assert.equal(cursorChargedFieldToCostBaseUsd(10), 0.1);
  assert.equal(cursorChargedFieldToCostBaseUsd(0), 0);
});

test("normalizeCursorChargeToCents: arredonda para INT na BD", () => {
  assert.equal(normalizeCursorChargeToCents(66.12), 66);
  assert.equal(normalizeCursorChargeToCents(18.8993), 19);
  assert.equal(normalizeCursorChargeToCents(15), 15);
});

test("chargedCentsToCostBaseUsd delega ao campo da API", () => {
  assert.equal(chargedCentsToCostBaseUsd(66.12), 0.6612);
});
