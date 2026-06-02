import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeForecastCostUsd,
  computePlannedProjectCostUsd,
  estimateTokensFromText,
} from "./billing-preview-estimate.js";
import {
  countPendingTasks,
  forecastFromBilling,
} from "../services/project-billing-service.js";

describe("billing-preview-estimate", () => {
  it("estimateTokensFromText", () => {
    assert.equal(estimateTokensFromText(""), 0);
    assert.equal(estimateTokensFromText("abcd"), 1);
    assert.equal(estimateTokensFromText("a".repeat(8)), 2);
  });

  it("computePlannedProjectCostUsd scales with microCount", () => {
    const scope = "x".repeat(4000);
    const one = computePlannedProjectCostUsd(scope, 1);
    const two = computePlannedProjectCostUsd(scope, 2);
    assert.ok(two > one);
    assert.equal(computePlannedProjectCostUsd(scope, 0), 0);
  });

  it("computeForecastCostUsd — real + restante proporcional", () => {
    assert.equal(
      computeForecastCostUsd(0.12, 2.4, 3, 8),
      1.02
    );
    assert.equal(computeForecastCostUsd(0.5, 0, 5, 10), 0.5);
    assert.equal(forecastFromBilling(0.12, 2.4, 3, 8), 1.02);
  });
});

describe("project-billing-service counts", () => {
  it("countPendingTasks ignora estados finais", () => {
    const tasks = [
      { status: "done" },
      { status: "todo" },
      { status: "in_progress" },
      { status: "cancelled" },
    ];
    assert.equal(countPendingTasks(tasks), 2);
  });
});
