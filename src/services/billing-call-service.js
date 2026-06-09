import { query, getPool } from "../db/pool.js";
import {
  cursorChargedFieldToCostBaseUsd,
  normalizeCursorChargeToCents,
} from "../lib/cursor-charge-cents.js";
import { aggregateJobChargeSource } from "../lib/charge-source.js";
import { chargedCentsToCostBaseUsd } from "../lib/billing-cursor-match.js";

/**
 * @param {string} tenantId
 * @param {string} jobId
 * @param {{
 *   callId: string,
 *   agentFile?: string,
 *   agentName?: string,
 *   startedAtMs: number,
 *   meta?: object,
 *   botEmail?: string,
 *   previewCostBaseUsd?: number,
 *   previewTokens?: number,
 *   previewSource?: string,
 * }} payload
 */
export async function registerAiCall(tenantId, jobId, payload) {
  const callId = String(payload.callId).trim();
  if (!callId) {
    throw Object.assign(new Error("callId obrigatório"), { status: 400 });
  }
  const startedAt = new Date(Number(payload.startedAtMs) || Date.now());
  const previewCb = Number(payload.previewCostBaseUsd) || 0;
  const previewSource =
    previewCb > 0 ? String(payload.previewSource || "token_preview").trim() : null;
  const initialStatus = previewCb > 0 ? "estimated" : "pending";

  await query(
    `INSERT INTO billing_ai_calls (
       id, tenant_id, job_id, agent_file, agent_name, meta, started_at,
       status, cost_base_usd, source
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       agent_file = EXCLUDED.agent_file,
       agent_name = EXCLUDED.agent_name,
       meta = EXCLUDED.meta,
       cost_base_usd = COALESCE(EXCLUDED.cost_base_usd, billing_ai_calls.cost_base_usd),
       source = COALESCE(EXCLUDED.source, billing_ai_calls.source),
       status = CASE
         WHEN EXCLUDED.cost_base_usd > 0 AND billing_ai_calls.status = 'pending'
           THEN 'estimated'
         ELSE billing_ai_calls.status
       END,
       updated_at = now()`,
    [
      callId,
      tenantId,
      jobId,
      payload.agentFile ?? null,
      payload.agentName ?? null,
      JSON.stringify({
        ...(payload.meta || {}),
        ...(payload.previewTokens != null
          ? { previewTokens: payload.previewTokens }
          : {}),
        ...(payload.botEmail
          ? { botEmail: String(payload.botEmail).trim().toLowerCase() }
          : {}),
      }),
      startedAt,
      initialStatus,
      previewCb,
      previewSource,
    ]
  );
  return { ok: true, callId };
}

/**
 * Fecha chamada no back (ended_at); custo Cursor fica a cargo do poller.
 * @param {string} tenantId
 * @param {string} callId
 * @param {{ endedAtMs: number, botEmail?: string }} payload
 */
export async function endAiCall(tenantId, callId, payload) {
  const endedAt = new Date(Number(payload.endedAtMs) || Date.now());
  const botEmail = String(payload.botEmail || "").trim().toLowerCase();

  if (botEmail) {
    await query(
      `UPDATE billing_ai_calls SET
         ended_at = $3,
         meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('botEmail', $4::text),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [callId, tenantId, endedAt, botEmail]
    );
  } else {
    await query(
      `UPDATE billing_ai_calls SET ended_at = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [callId, tenantId, endedAt]
    );
  }
  return { ok: true, callId };
}

/**
 * @param {{
 *   tenantId: string,
 *   botEmail: string,
 *   jobId: string,
 *   callId: string,
 *   claims: Array<{ key: string, eventTimestampMs: number, chargedCents: number }>,
 * }} input
 */
export async function insertClaimsForCall(input) {
  const { tenantId, botEmail, jobId, callId, claims } = input;
  const inserted = [];
  const conflictKeys = [];

  for (const claim of claims) {
    const { rows } = await query(
      `INSERT INTO billing_cursor_event_claims (
         tenant_id, bot_email, cursor_event_key, event_timestamp_ms,
         charged_cents, job_id, call_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, bot_email, cursor_event_key) DO NOTHING
       RETURNING cursor_event_key`,
      [
        tenantId,
        botEmail,
        claim.key,
        claim.eventTimestampMs,
        normalizeCursorChargeToCents(claim.chargedCents),
        jobId,
        callId,
      ]
    );
    if (rows[0]) {
      inserted.push(rows[0].cursor_event_key);
    } else {
      conflictKeys.push(claim.key);
    }
  }

  return { inserted, conflictKeys };
}

/**
 * @param {string} tenantId
 * @param {string} callId
 * @param {{
 *   endedAtMs?: number,
 *   costBaseUsd?: number,
 *   source?: string,
 *   matchDeltaMs?: number|null,
 *   cursorMatchedEventMs?: number|null,
 *   status?: string,
 *   botEmail?: string,
 *   jobId?: string,
 *   cursorEventKeys?: Array<{ key: string, eventTimestampMs: number, chargedCents: number }>,
 * }} payload
 */
export async function settleAiCall(tenantId, callId, payload) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: callRows } = await client.query(
      `SELECT id, job_id FROM billing_ai_calls
       WHERE id = $1 AND tenant_id = $2`,
      [callId, tenantId]
    );
    if (!callRows[0]) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Chamada não encontrada"), { status: 404 });
    }

    const jobId = payload.jobId || callRows[0].job_id;
    const botEmail = String(payload.botEmail || "").trim().toLowerCase();
    const status =
      payload.status === "estimated"
        ? "estimated"
        : payload.status === "pending"
          ? "pending"
          : "settled";

    let costBaseUsd = Number(payload.costBaseUsd) || 0;
    let conflictKeys = [];

    if (botEmail && Array.isArray(payload.cursorEventKeys) && payload.cursorEventKeys.length > 0) {
      const claimResult = await insertClaimsWithClient(client, {
        tenantId,
        botEmail,
        jobId,
        callId,
        claims: payload.cursorEventKeys,
      });
      conflictKeys = claimResult.conflictKeys;
      if (claimResult.inserted.length > 0) {
        costBaseUsd = payload.cursorEventKeys
          .filter((c) => claimResult.inserted.includes(c.key))
          .reduce(
            (s, c) => s + cursorChargedFieldToCostBaseUsd(c.chargedCents),
            0
          );
        costBaseUsd = Math.round(costBaseUsd * 1_000_000) / 1_000_000;
      } else if (status !== "estimated") {
        costBaseUsd = 0;
      }
    }

    const endedAt = payload.endedAtMs
      ? new Date(Number(payload.endedAtMs))
      : null;

    await client.query(
      `UPDATE billing_ai_calls SET
         ended_at = COALESCE($3, ended_at),
         status = $4,
         cost_base_usd = $5,
         source = $6,
         match_delta_ms = $7,
         cursor_matched_event_ms = COALESCE($8, cursor_matched_event_ms),
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        callId,
        tenantId,
        endedAt,
        status,
        costBaseUsd,
        payload.source ?? null,
        payload.matchDeltaMs ?? null,
        payload.cursorMatchedEventMs != null
          ? Number(payload.cursorMatchedEventMs)
          : null,
      ]
    );

    await client.query("COMMIT");
    return { ok: true, callId, costBaseUsd, conflictKeys };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {import('pg').PoolClient} client
 */
async function insertClaimsWithClient(client, input) {
  const { tenantId, botEmail, jobId, callId, claims } = input;
  const inserted = [];
  const conflictKeys = [];

  for (const claim of claims) {
    const { rows } = await client.query(
      `INSERT INTO billing_cursor_event_claims (
         tenant_id, bot_email, cursor_event_key, event_timestamp_ms,
         charged_cents, job_id, call_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, bot_email, cursor_event_key) DO NOTHING
       RETURNING cursor_event_key`,
      [
        tenantId,
        botEmail,
        claim.key,
        claim.eventTimestampMs,
        normalizeCursorChargeToCents(claim.chargedCents),
        jobId,
        callId,
      ]
    );
    if (rows[0]) {
      inserted.push(rows[0].cursor_event_key);
    } else {
      conflictKeys.push(claim.key);
    }
  }

  return { inserted, conflictKeys };
}

/**
 * @param {string} tenantId
 * @param {string} botEmail
 * @param {{ sinceMs: number, untilMs: number }} range
 * @returns {Promise<string[]>}
 */
export async function loadConsumedKeys(tenantId, botEmail, range) {
  const email = String(botEmail || "").trim().toLowerCase();
  if (!email) return [];
  const since = Number(range.sinceMs) || 0;
  const until = Number(range.untilMs) || Date.now();
  const { rows } = await query(
    `SELECT cursor_event_key FROM billing_cursor_event_claims
     WHERE tenant_id = $1 AND bot_email = $2
       AND event_timestamp_ms >= $3 AND event_timestamp_ms <= $4`,
    [tenantId, email, since, until]
  );
  return rows.map((r) => r.cursor_event_key);
}

/**
 * @param {string} jobId
 */
export async function loadOpenCallsForJob(jobId) {
  const { rows } = await query(
    `SELECT id, agent_file, agent_name, meta, started_at, cost_base_usd, status
     FROM billing_ai_calls WHERE job_id = $1 AND status = 'pending'
     ORDER BY started_at`,
    [jobId]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 * @param {{
 *   botEmail: string,
 *   totalCostBaseUsd: number,
 *   calls: Array<{
 *     callId: string,
 *     endedAtMs?: number,
 *     costBaseUsd?: number,
 *     source?: string,
 *     status?: string,
 *     matchDeltaMs?: number|null,
 *     cursorEventKeys?: Array<{ key: string, eventTimestampMs: number, chargedCents: number }>,
 *   }>,
 * }} payload
 */
export async function reconcileJobCalls(tenantId, jobId, payload) {
  const pool = getPool();
  const client = await pool.connect();
  const botEmail = String(payload.botEmail || "").trim().toLowerCase();

  try {
    await client.query("BEGIN");

    for (const call of payload.calls || []) {
      const callId = String(call.callId).trim();
      if (!callId) continue;

      await client.query(
        `INSERT INTO billing_ai_calls (id, tenant_id, job_id, agent_file, started_at, status)
         VALUES ($1, $2, $3, '', now(), 'pending')
         ON CONFLICT (id) DO NOTHING`,
        [callId, tenantId, jobId]
      );

      if (botEmail && Array.isArray(call.cursorEventKeys)) {
        await insertClaimsWithClient(client, {
          tenantId,
          botEmail,
          jobId,
          callId,
          claims: call.cursorEventKeys,
        });
      }

      const status =
        call.status === "estimated"
          ? "estimated"
          : call.status === "pending"
            ? "pending"
            : "settled";

      await client.query(
        `UPDATE billing_ai_calls SET
           ended_at = COALESCE($4, ended_at),
           status = $5,
           cost_base_usd = $6,
           source = $7,
           match_delta_ms = $8,
           updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND job_id = $3`,
        [
          callId,
          tenantId,
          jobId,
          call.endedAtMs ? new Date(Number(call.endedAtMs)) : null,
          status,
          Number(call.costBaseUsd) || 0,
          call.source ?? null,
          call.matchDeltaMs ?? null,
        ]
      );
    }

    const { rows: sumRows } = await client.query(
      `SELECT COALESCE(SUM(cost_base_usd), 0)::float AS total
       FROM billing_ai_calls WHERE job_id = $1 AND tenant_id = $2`,
      [jobId, tenantId]
    );

    await client.query("COMMIT");

    const totalCostBaseUsd =
      Number(payload.totalCostBaseUsd) ||
      Math.round((Number(sumRows[0]?.total) || 0) * 1_000_000) / 1_000_000;

    return {
      totalCostBaseUsd,
      callCount: (payload.calls || []).length,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {string} tenantId
 */
export async function countBillingCallsForTenant(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total
     FROM billing_ai_calls c
     WHERE c.tenant_id = $1
       AND c.source IS DISTINCT FROM 'skipped'`,
    [tenantId]
  );
  return rows[0]?.total || 0;
}

/**
 * @param {string} tenantId
 * @param {number} [limit]
 */
export async function listRecentBillingCalls(tenantId, limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await query(
    `SELECT c.id AS execution_id,
            c.job_id,
            c.started_at,
            c.ended_at,
            c.cursor_matched_event_ms,
            c.cost_base_usd,
            c.source AS charge_source,
            c.status,
            c.agent_name,
            u.email AS executor_email
     FROM billing_ai_calls c
     JOIN jobs j ON j.id = c.job_id
     LEFT JOIN users u ON u.id = j.requested_by_user_id
     WHERE c.tenant_id = $1
       AND c.source IS DISTINCT FROM 'skipped'
     ORDER BY COALESCE(c.ended_at, c.started_at) DESC
     LIMIT $2`,
    [tenantId, lim]
  );
  return rows;
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function listJobBillingCalls(tenantId, jobId) {
  const { rows: calls } = await query(
    `SELECT c.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'key', cl.cursor_event_key,
                  'chargedCents', cl.charged_cents,
                  'eventTimestampMs', cl.event_timestamp_ms
                )
              ) FILTER (WHERE cl.id IS NOT NULL),
              '[]'
            ) AS claims
     FROM billing_ai_calls c
     LEFT JOIN billing_cursor_event_claims cl ON cl.call_id = c.id
     WHERE c.tenant_id = $1 AND c.job_id = $2
     GROUP BY c.id
     ORDER BY c.started_at`,
    [tenantId, jobId]
  );
  return calls;
}

/** Settle poller — espelho em ai-factory-poller/src/services/billing-settle-service.js */
const SETTLE_GRACE_SECONDS = 5;
const POLL_BATCH_LIMIT = 50;

/**
 * Âncora temporal para match/ordenação: ended_at quando existir, senão started_at.
 * @param {Date|string|number|null|undefined} startedAt
 * @param {Date|string|number|null|undefined} endedAt
 */
export function billingCallAnchorMs(startedAt, endedAt) {
  const ended = endedAt != null ? new Date(endedAt).getTime() : NaN;
  const started = startedAt != null ? new Date(startedAt).getTime() : NaN;
  if (Number.isFinite(ended)) return ended;
  if (Number.isFinite(started)) return started;
  return NaN;
}

/**
 * @param {number} [limit]
 */
export async function listCallsAwaitingCursorSettle(limit = POLL_BATCH_LIMIT) {
  const lim = Math.min(Math.max(Number(limit) || POLL_BATCH_LIMIT, 1), 100);
  const { rows } = await query(
    `SELECT c.id,
            c.tenant_id,
            c.job_id,
            c.started_at,
            c.ended_at,
            c.meta,
            COALESCE(
              NULLIF(TRIM(c.meta->>'botEmail'), ''),
              tw.cursor_bot_email
            ) AS bot_email
     FROM billing_ai_calls c
     LEFT JOIN work_locks wl ON wl.job_id = c.job_id
     LEFT JOIN tenant_workers tw
       ON tw.tenant_id = c.tenant_id AND tw.worker_slot = wl.worker_slot
     WHERE c.status IN ('pending', 'estimated')
       AND c.source IS DISTINCT FROM 'cursor_admin_api'
       AND COALESCE(c.ended_at, c.started_at)
         + make_interval(secs => $2::double precision) < now()
     ORDER BY COALESCE(c.ended_at, c.started_at) ASC
     LIMIT $1`,
    [lim, SETTLE_GRACE_SECONDS]
  );
  return rows;
}

/**
 * Aplica match Cursor (1 evento) numa chamada — uso do poller.
 * @param {{
 *   tenantId: string,
 *   callId: string,
 *   jobId: string,
 *   botEmail: string,
 *   match: { key: string, eventTimestampMs: number, chargedCents: number, matchDeltaMs: number },
 * }} input
 * @returns {Promise<{ ok: boolean, costBaseUsd: number, claimSkipped: boolean }>}
 */
export async function applyCursorMatchToCall(input) {
  const { tenantId, callId, jobId, botEmail, match } = input;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const claimResult = await insertClaimsWithClient(client, {
      tenantId,
      botEmail,
      jobId,
      callId,
      claims: [
        {
          key: match.key,
          eventTimestampMs: match.eventTimestampMs,
          chargedCents: match.chargedCents,
        },
      ],
    });

    if (claimResult.inserted.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, costBaseUsd: 0, claimSkipped: true };
    }

    const costBaseUsd = chargedCentsToCostBaseUsd(match.chargedCents);

    await client.query(
      `UPDATE billing_ai_calls SET
         status = 'settled',
         cost_base_usd = $3,
         source = 'cursor_admin_api',
         match_delta_ms = $4,
         cursor_matched_event_ms = $5,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [
        callId,
        tenantId,
        costBaseUsd,
        match.matchDeltaMs,
        match.eventTimestampMs,
      ]
    );

    await client.query("COMMIT");
    return { ok: true, costBaseUsd, claimSkipped: false };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function sumJobBillingCalls(tenantId, jobId) {
  const { rows } = await query(
    `SELECT cost_base_usd, source, status
     FROM billing_ai_calls
     WHERE tenant_id = $1 AND job_id = $2
       AND source IS DISTINCT FROM 'skipped'`,
    [tenantId, jobId]
  );

  let totalCostBaseUsd = 0;
  const sources = [];
  let openCount = 0;

  for (const r of rows) {
    totalCostBaseUsd += Number(r.cost_base_usd) || 0;
    sources.push(r.source || "pending");
    if (r.status !== "settled" || r.source !== "cursor_admin_api") {
      openCount += 1;
    }
  }

  totalCostBaseUsd =
    Math.round(totalCostBaseUsd * 1_000_000) / 1_000_000;

  return {
    totalCostBaseUsd,
    chargeSource: aggregateJobChargeSource(sources),
    callCount: rows.length,
    openCount,
  };
}

/**
 * Todas as calls do job estão settled (ou skipped)?
 * @param {string} tenantId
 * @param {string} jobId
 */
export async function areAllJobCallsSettled(tenantId, jobId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS open
     FROM billing_ai_calls
     WHERE tenant_id = $1 AND job_id = $2
       AND source IS DISTINCT FROM 'skipped'
       AND (status <> 'settled' OR source IS DISTINCT FROM 'cursor_admin_api')`,
    [tenantId, jobId]
  );
  return (rows[0]?.open || 0) === 0;
}
