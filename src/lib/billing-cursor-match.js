import {
  cursorEventKey,
  eventTimestampMs,
  filterUsageEvents,
} from "./cursor-admin-api.js";
import { cursorChargedFieldToCostBaseUsd } from "./cursor-charge-cents.js";
import { billingMatchDeltaMs } from "./billing-match-config.js";

/**
 * Primeiro evento Cursor elegível: não consumido, dentro da folga de ended_at,
 * desempate pelo timestamp mais antigo (resolve ambiguidade nas rodadas seguintes).
 * @param {{
 *   startedMs: number,
 *   endedMs: number,
 *   events: object[],
 *   consumedKeys?: Set<string>,
 *   email?: string,
 *   maxMatchDeltaMs?: number,
 * }} opts
 * @returns {{
 *   key: string,
 *   eventTimestampMs: number,
 *   chargedCents: number,
 *   matchDeltaMs: number,
 * } | null}
 */
export function pickBestCursorEvent(opts) {
  const endedMs = Number(opts.endedMs);
  const startedMs = Number(opts.startedMs);
  const anchorMs = Number.isFinite(endedMs)
    ? endedMs
    : Number.isFinite(startedMs)
      ? startedMs
      : NaN;
  if (!Number.isFinite(anchorMs)) return null;

  const maxDelta = opts.maxMatchDeltaMs ?? billingMatchDeltaMs();
  const consumed = opts.consumedKeys || new Set();
  const pool = filterUsageEvents(opts.events || [], { email: opts.email });

  let best = null;

  for (const ev of pool) {
    const ts = eventTimestampMs(ev);
    if (!Number.isFinite(ts)) continue;

    const dist = Math.abs(ts - anchorMs);
    if (dist > maxDelta) continue;

    const key = cursorEventKey(ev);
    if (consumed.has(key)) continue;

    if (!best || ts < best.eventTimestampMs) {
      best = {
        key,
        eventTimestampMs: ts,
        chargedCents: Number(ev.chargedCents) || 0,
        matchDeltaMs: Math.round(dist),
      };
    }
  }

  return best;
}

/** @param {number} chargedCents valor bruto do campo `chargedCents` da API */
export function chargedCentsToCostBaseUsd(chargedCents) {
  return cursorChargedFieldToCostBaseUsd(chargedCents);
}
