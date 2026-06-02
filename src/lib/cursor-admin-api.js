import { normalizeCursorChargeToCents } from "./cursor-charge-cents.js";

const CURSOR_API_BASE = "https://api.cursor.com";

/**
 * @param {string} apiKey
 */
function basicAuthHeader(apiKey) {
  const token = Buffer.from(`${apiKey}:`, "utf-8").toString("base64");
  return `Basic ${token}`;
}

/**
 * POST /teams/filtered-usage-events (uma página).
 * @param {{
 *   apiKey: string,
 *   startDate: number,
 *   endDate: number,
 *   page?: number,
 *   pageSize?: number,
 *   email?: string,
 * }} opts
 */
export async function fetchFilteredUsageEventsPage(opts) {
  const {
    apiKey,
    startDate,
    endDate,
    page = 1,
    pageSize = 100,
    email,
  } = opts;

  const body = { startDate, endDate, page, pageSize };
  if (email) body.email = email;

  const res = await fetch(`${CURSOR_API_BASE}/teams/filtered-usage-events`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cursor Admin API ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

/**
 * Todas as páginas no intervalo.
 * @param {string} apiKey
 * @param {{
 *   startDate: number,
 *   endDate: number,
 *   email?: string,
 *   pageSize?: number,
 *   maxPages?: number,
 * }} opts
 */
export async function fetchAllFilteredUsageEvents(apiKey, opts) {
  if (!apiKey?.trim()) {
    return { events: [], source: "none", reason: "CURSOR_ADMIN_API_KEY ausente" };
  }

  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 120;
  const events = [];
  let page = 1;
  let hasNextPage = true;
  let period = null;

  while (hasNextPage && page <= maxPages) {
    const data = await fetchFilteredUsageEventsPage({
      apiKey,
      startDate: opts.startDate,
      endDate: opts.endDate,
      page,
      pageSize,
      email: opts.email,
    });
    if (data.period) period = data.period;
    if (Array.isArray(data.usageEvents)) {
      events.push(...data.usageEvents);
    }
    hasNextPage = data.pagination?.hasNextPage === true;
    page += 1;
  }

  return {
    events,
    period,
    totalUsageEventsCount: events.length,
    source: "cursor_admin_api",
  };
}

export { normalizeCursorChargeToCents };

/**
 * @param {object} ev
 */
export function eventTimestampMs(ev) {
  const ts = Number(ev?.timestamp);
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * Chave estável para deduplicar eventos Cursor entre chamadas/jobs.
 * @param {object} ev
 */
export function cursorEventKey(ev) {
  if (ev?.id != null && String(ev.id).trim()) return String(ev.id);
  if (ev?.eventId != null && String(ev.eventId).trim()) return String(ev.eventId);
  const ts = eventTimestampMs(ev);
  return [
    ts,
    ev.chargedCents ?? 0,
    ev.userEmail ?? "",
    ev.model ?? ev.modelName ?? "",
    ev.isHeadless ? 1 : 0,
  ].join("|");
}

/**
 * @param {object[]} events
 * @param {{ email?: string }} [opts]
 */
export function filterUsageEvents(events, opts = {}) {
  const email = opts.email?.trim();
  return events.filter((ev) => {
    if (ev.isChargeable === false) return false;
    if (email && ev.userEmail && ev.userEmail !== email) return false;
    return true;
  });
}
