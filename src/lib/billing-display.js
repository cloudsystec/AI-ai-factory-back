import { computeCharge } from "../billing/index.js";
import { normalizeChargeSource } from "./charge-source.js";

/**
 * Cobrança (CC) exibida ao cliente a partir do CB da chamada.
 * @param {number|null|undefined} costBaseUsd
 * @param {string|null|undefined} chargeSource
 */
export function resolveCallDisplayChargeUsd(costBaseUsd, chargeSource) {
  const source = normalizeChargeSource(chargeSource);
  if (source === "skipped") return 0;
  const cb = Number(costBaseUsd);
  const safeCb = Number.isFinite(cb) && cb >= 0 ? cb : 0;
  return computeCharge(safeCb, "completed").cc;
}

/**
 * @param {string|null|undefined} callStatus
 */
export function mapCallStatusForUi(callStatus) {
  const s = String(callStatus || "").trim();
  if (s === "settled") return "completed";
  if (s === "cancelled") return "cancelled";
  if (s === "failed") return "failed";
  return "estimated";
}

/**
 * Horário alinhado ao dashboard Cursor: timestamp do evento matched, senão fim da chamada.
 * @param {{
 *   cursor_matched_event_ms?: number|string|null,
 *   ended_at?: Date|string|null,
 *   started_at?: Date|string|null,
 * }} row
 */
export function billingCallDisplayAt(row) {
  const matchedMs = Number(row.cursor_matched_event_ms);
  if (Number.isFinite(matchedMs) && matchedMs > 0) {
    return new Date(matchedMs).toISOString();
  }
  if (row.ended_at) {
    return row.ended_at instanceof Date
      ? row.ended_at.toISOString()
      : new Date(row.ended_at).toISOString();
  }
  if (row.started_at) {
    return row.started_at instanceof Date
      ? row.started_at.toISOString()
      : new Date(row.started_at).toISOString();
  }
  return null;
}
