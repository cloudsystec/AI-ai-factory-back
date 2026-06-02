/** @type {Set<string>} */
const CONFIRMED_SOURCES = new Set(["cursor_admin_api"]);

/** Fontes que indicam valor padrão / não confirmado pela Cursor. */
export const UNCONFIRMED_SOURCES = new Set([
  "estimate",
  "estimate_default",
  "estimate_reconcile",
  "estimate_error",
  "token_preview",
  "pending",
  "fee_minimum",
  "skipped",
]);

/**
 * @param {string|null|undefined} source
 */
export function isChargeConfirmed(source) {
  return CONFIRMED_SOURCES.has(String(source || "").trim());
}

/**
 * @param {string|null|undefined} source
 */
export function normalizeChargeSource(source) {
  const s = String(source || "").trim();
  return s || "estimate";
}

/**
 * Define charge_source sem inferir pelo valor em USD (evita falso positivo em $0.01 real).
 * @param {{
 *   costBaseUsd?: number|null,
 *   chargeSource?: string,
 * }} payload
 */
export function resolveJobChargeSource(payload) {
  if (payload.chargeSource) {
    return normalizeChargeSource(payload.chargeSource);
  }
  if (payload.costBaseUsd == null) {
    return "estimate_default";
  }
  const cb = Number(payload.costBaseUsd);
  if (Number.isFinite(cb) && cb > 0) {
    // CB > 0 sem source explícita: conservador (worker deve enviar source)
    return "estimate";
  }
  return "fee_minimum";
}

/**
 * Agrega fontes das calls numa fonte de job.
 * @param {string[]} sources
 */
export function aggregateJobChargeSource(sources) {
  const list = sources.map(normalizeChargeSource).filter(Boolean);
  if (list.length === 0) return "estimate";
  if (list.every((s) => CONFIRMED_SOURCES.has(s))) return "cursor_admin_api";
  if (list.some((s) => s === "estimate_reconcile" || s === "estimate_error"))
    return "estimate_reconcile";
  if (list.some((s) => s === "token_preview")) return "token_preview";
  if (list.some((s) => s.startsWith("estimate"))) return "estimate";
  if (list.some((s) => s === "pending")) return "pending";
  if (list.some((s) => s === "fee_minimum")) return "fee_minimum";
  if (list.every((s) => s === "skipped")) return "skipped";
  return "estimate";
}
