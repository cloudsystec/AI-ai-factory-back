/**
 * @param {number} cb Custo base (USD)
 * @returns {number}
 */
export function computeTokenFee(cb) {
  const n = Number(cb);
  if (!Number.isFinite(n) || n < 0) return 0.01;
  return Math.max(0.01, n * 0.15);
}

/**
 * @param {number} cb
 * @param {'completed'|'failed'|'cancelled'|string} status
 * @returns {{ cc: number, debitCb: boolean, fee: number }}
 */
export function computeCharge(cb, status) {
  const base = Number(cb);
  const safeCb = Number.isFinite(base) && base >= 0 ? base : 0;
  if (status === "cancelled") {
    const fee = computeTokenFee(safeCb);
    return { cc: fee, debitCb: false, fee };
  }
  const fee = computeTokenFee(safeCb);
  return { cc: safeCb + fee, debitCb: true, fee };
}

/**
 * @param {number} poolCredit
 * @param {number} unused
 * @returns {{ effective: number, expired: number }}
 */
export function applyRollover(poolCredit, unused) {
  const pool = Number(poolCredit);
  const u = Math.max(0, Number(unused));
  const max = pool * 0.2;
  const effective = Math.min(u, max);
  return { effective, expired: u - effective };
}

/**
 * @param {number} balance
 * @param {boolean} hasActiveJob
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function canStartJob(balance, hasActiveJob) {
  const b = Number(balance);
  if (b > 0) return { allowed: true };
  if (hasActiveJob && b >= -5) return { allowed: true };
  return { allowed: false, reason: "insufficient_balance" };
}
