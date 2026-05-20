import { createClient } from "redis";

const LOG_KEY_PREFIX = "aifactory:job:";
const LOG_SUFFIX = ":log";
const LIVE_SUFFIX = ":live";

/** @type {import("redis").RedisClientType | null} */
let commandClient = null;

export function logListKey(jobId) {
  return `${LOG_KEY_PREFIX}${jobId}${LOG_SUFFIX}`;
}

export function logLiveChannel(jobId) {
  return `${LOG_KEY_PREFIX}${jobId}${LIVE_SUFFIX}`;
}

export function getRedisUrl() {
  return process.env.REDIS_URL || "redis://127.0.0.1:6379";
}

export function getJobLogTtlSeconds() {
  const n = Number(process.env.JOB_LOG_TTL_SECONDS ?? 604800);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 604800;
}

/**
 * @returns {Promise<import("redis").RedisClientType>}
 */
export async function getCommandRedis() {
  if (!commandClient) {
    commandClient = createClient({ url: getRedisUrl() });
    commandClient.on("error", (err) => {
      console.error("[job-log-redis]", err.message);
    });
    await commandClient.connect();
  }
  return commandClient;
}

/**
 * @param {string} jobId
 */
export async function resetJobLog(jobId) {
  const redis = await getCommandRedis();
  await redis.del(logListKey(jobId));
  await publishJobLogEvent(jobId, { type: "reset" });
}

/**
 * @param {string} jobId
 * @param {object} event
 */
export async function publishJobLogEvent(jobId, event) {
  const redis = await getCommandRedis();
  await redis.publish(logLiveChannel(jobId), JSON.stringify(event));
}

/**
 * @param {string} jobId
 * @param {string} line
 */
export async function appendJobLogLine(jobId, line) {
  const redis = await getCommandRedis();
  const key = logListKey(jobId);
  const seq = await redis.lLen(key);
  await redis.rPush(key, line);
  await publishJobLogEvent(jobId, {
    type: "line",
    text: line,
    stream: "stdout",
    seq: Number(seq),
  });
}

/**
 * @param {string} jobId
 * @returns {Promise<string>}
 */
export async function readJobLogFull(jobId) {
  const redis = await getCommandRedis();
  const lines = await redis.lRange(logListKey(jobId), 0, -1);
  if (!Array.isArray(lines) || lines.length === 0) return "";
  return lines.join("\n");
}

/**
 * @param {string} jobId
 * @param {{ onMessage: (event: object) => void, onError?: (err: Error) => void }} handlers
 * @returns {Promise<() => Promise<void>>}
 */
export async function subscribeJobLogLive(jobId, handlers) {
  const base = await getCommandRedis();
  const sub = base.duplicate();
  sub.on("error", (err) => handlers.onError?.(err));
  await sub.connect();

  const channel = logLiveChannel(jobId);
  await sub.subscribe(channel, (message) => {
    try {
      const event = JSON.parse(message);
      handlers.onMessage(event);
    } catch (err) {
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return async () => {
    try {
      await sub.unsubscribe(channel);
      await sub.quit();
    } catch {
      /* ignore */
    }
  };
}

/**
 * @param {string} jobId
 * @param {number} [ttlSeconds]
 */
export async function setJobLogExpiry(jobId, ttlSeconds = getJobLogTtlSeconds()) {
  const redis = await getCommandRedis();
  const key = logListKey(jobId);
  const exists = await redis.exists(key);
  if (exists) {
    await redis.expire(key, ttlSeconds);
  }
}

/**
 * Fecha cliente de comandos (testes / shutdown).
 */
export async function closeJobLogRedis() {
  if (commandClient) {
    await commandClient.quit();
    commandClient = null;
  }
}
