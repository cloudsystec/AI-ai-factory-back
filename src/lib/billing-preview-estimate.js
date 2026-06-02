import { cursorChargedFieldToCostBaseUsd } from "./cursor-charge-cents.js";

export const CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS = Number(
  process.env.CURSOR_PREVIEW_CHARGE_FIELD_PER_MILLION ??
    process.env.CURSOR_USD_PER_MILLION_TOKENS ??
    0.8
);

export function projectCostPipelineFactor() {
  const raw = Number(process.env.PROJECT_COST_MICRO_PIPELINE_FACTOR);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

/**
 * @param {string|null|undefined} text
 */
export function estimateTokensFromText(text) {
  const s = String(text || "");
  if (!s.length) return 0;
  return Math.ceil(s.length / 4);
}

/**
 * @param {number} tokenCount
 */
export function computePreviewCostBaseUsd(tokenCount) {
  const n = Number(tokenCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const chargeField = (n / 1_000_000) * CURSOR_CHARGE_FIELD_PER_MILLION_TOKENS;
  return cursorChargedFieldToCostBaseUsd(chargeField);
}

/**
 * Meta planeada do projeto (scope + pipeline por micro).
 * @param {string|null|undefined} scopeMd
 * @param {number} microCount
 */
export function computePlannedProjectCostUsd(scopeMd, microCount) {
  const micros = Math.max(0, Number(microCount) || 0);
  if (micros <= 0) return 0;
  const scopeTokens = estimateTokensFromText(scopeMd);
  const scopeUsd = computePreviewCostBaseUsd(scopeTokens);
  const factor = projectCostPipelineFactor();
  return Math.round(scopeUsd * micros * factor * 1_000_000) / 1_000_000;
}

/**
 * @param {number} actualUsd
 * @param {number} plannedUsd
 * @param {number} pendingUnits
 * @param {number} plannedUnits
 */
export function computeForecastCostUsd(
  actualUsd,
  plannedUsd,
  pendingUnits,
  plannedUnits
) {
  const actual = Math.max(0, Number(actualUsd) || 0);
  const planned = Math.max(0, Number(plannedUsd) || 0);
  const pending = Math.max(0, Number(pendingUnits) || 0);
  const totalUnits = Math.max(0, Number(plannedUnits) || 0);
  if (planned <= 0 || totalUnits <= 0) {
    return Math.round(actual * 1_000_000) / 1_000_000;
  }
  const unitCost = planned / totalUnits;
  const remainder = pending * unitCost;
  return Math.round((actual + remainder) * 1_000_000) / 1_000_000;
}
