/**
 * Campo `chargedCents` da Cursor Admin API: centavos de USD (ex.: 66.12 = US$ 0.6612).
 * @param {number|string|null|undefined} raw
 * @returns {number} USD (cost_base)
 */
export function cursorChargedFieldToCostBaseUsd(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n / 100) * 1_000_000) / 1_000_000;
}

/**
 * Centavos inteiros para `billing_cursor_event_claims.charged_cents` (arredonda o valor da API).
 * @param {number|string|null|undefined} raw
 * @returns {number}
 */
export function normalizeCursorChargeToCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}
