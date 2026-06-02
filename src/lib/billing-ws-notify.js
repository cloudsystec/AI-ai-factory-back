import { broadcast } from "./ws-hub.js";
import { getCommandRedis } from "./job-log-redis.js";

/** Canal Redis para push de billing entre processos (API ↔ poller). */
export function billingLiveChannel(tenantId) {
  return `aifactory:tenant:${tenantId}:billing`;
}

export const BILLING_LIVE_REDIS_PATTERN = "aifactory:tenant:*:billing";

/**
 * Notifica o front (WS na API) que o resumo de billing mudou.
 * Publica no Redis para outros processos (ex.: billing-poller) alcançarem a API.
 * @param {string} tenantId
 * @param {object} [event]
 */
export async function notifyBillingUpdate(tenantId, event = { type: "billing" }) {
  broadcast(tenantId, event);
  try {
    const redis = await getCommandRedis();
    await redis.publish(billingLiveChannel(tenantId), JSON.stringify(event));
  } catch {
    /* Redis opcional em dev mínimo */
  }
}
