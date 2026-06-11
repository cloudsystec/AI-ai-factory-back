const GUARD_KEY_PREFIX = "copilot:guard:";
const STRIKE_RESET_MS = 30 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;
const MAX_STRIKES = 3;

const SENSITIVE_PATTERNS = [
  /\bselect\s+.+\s+from\b/i,
  /\b(insert|update|delete|drop|truncate|alter)\s+/i,
  /\bsql\b/i,
  /\bquery\b.+\b(banco|database|postgres|sql)\b/i,
  /\b(banco|database|postgres|schema|tabela)\b.+\b(mostrar|ver|listar|dump|export)\b/i,
  /\b(api[_\s-]?key|chave\s+(admin|cursor|api)|password|senha|token|jwt|secret)\b/i,
  /\b(saldo|balance|billing|stripe|custo)\b.+\b(alterar|mudar|editar|aumentar|diminuir|grátis)\b/i,
  /\b(outro|another)\s+(tenant|projeto|project)\b/i,
  /\btenant[_\s-]?id\b/i,
  /\bwork[_\s-]?secret\b/i,
  /\bencryption[_\s-]?key\b/i,
];

/**
 * @param {string} text
 */
export function classifySensitiveIntent(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(normalized)) {
      return "Pedido sensível detectado — não posso aceder a dados protegidos, alterar custos ou executar SQL.";
    }
  }
  return null;
}

/**
 * @param {string} tenantId
 * @param {string} userId
 */
function guardKey(tenantId, userId) {
  return `${GUARD_KEY_PREFIX}${tenantId}:${userId}`;
}

/**
 * @param {import("redis").RedisClientType} redis
 * @param {string} tenantId
 * @param {string} userId
 */
async function readGuardState(redis, tenantId, userId) {
  const raw = await redis.get(guardKey(tenantId, userId));
  if (!raw) return { strikes: 0, lockedUntil: null, lastStrikeAt: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { strikes: 0, lockedUntil: null, lastStrikeAt: null };
  }
}

/**
 * @param {import("redis").RedisClientType} redis
 * @param {string} tenantId
 * @param {string} userId
 * @param {{ strikes: number, lockedUntil: number|null, lastStrikeAt: number|null }} state
 */
async function writeGuardState(redis, tenantId, userId, state) {
  const ttlSec = Math.ceil((LOCK_MS + STRIKE_RESET_MS) / 1000);
  await redis.set(guardKey(tenantId, userId), JSON.stringify(state), { EX: ttlSec });
}

/**
 * @param {string} tenantId
 * @param {string} userId
 */
export async function getCopilotGuardStatus(tenantId, userId) {
  const { getCommandRedis } = await import("../lib/job-log-redis.js");
  const redis = await getCommandRedis();
  const state = await readGuardState(redis, tenantId, userId);
  const now = Date.now();
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      locked: true,
      lockedUntil: new Date(state.lockedUntil).toISOString(),
      strikes: state.strikes,
      remainingMs: state.lockedUntil - now,
    };
  }
  return { locked: false, lockedUntil: null, strikes: state.strikes ?? 0 };
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} message
 */
export async function assertCopilotGuardAllows(tenantId, userId, message) {
  const { getCommandRedis } = await import("../lib/job-log-redis.js");
  const redis = await getCommandRedis();
  const state = await readGuardState(redis, tenantId, userId);
  const now = Date.now();

  if (state.lastStrikeAt && now - state.lastStrikeAt > STRIKE_RESET_MS) {
    state.strikes = 0;
    state.lockedUntil = null;
  }

  if (state.lockedUntil && state.lockedUntil > now) {
    throw Object.assign(
      new Error(
        `Copiloto bloqueado por segurança. Tente novamente em ${Math.ceil((state.lockedUntil - now) / 1000)}s.`
      ),
      {
        status: 429,
        code: "copilot_locked",
        lockedUntil: new Date(state.lockedUntil).toISOString(),
      }
    );
  }

  const reason = classifySensitiveIntent(message);
  if (!reason) return { ok: true };

  const strikes = (state.strikes ?? 0) + 1;
  const next = {
    strikes,
    lastStrikeAt: now,
    lockedUntil: strikes >= MAX_STRIKES ? now + LOCK_MS : null,
  };
  await writeGuardState(redis, tenantId, userId, next);

  if (strikes >= MAX_STRIKES) {
    throw Object.assign(
      new Error(
        "Muitas tentativas sensíveis. Copiloto bloqueado por 5 minutos."
      ),
      {
        status: 429,
        code: "copilot_locked",
        lockedUntil: new Date(next.lockedUntil).toISOString(),
      }
    );
  }

  throw Object.assign(
    new Error(`${reason} Aviso ${strikes}/${MAX_STRIKES}.`),
    { status: 403, code: "copilot_sensitive_warning", strikes, maxStrikes: MAX_STRIKES }
  );
}
