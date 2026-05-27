import { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import { createClient } from "redis";
import { createLogger } from "./logger.js";
import { getRedisUrl } from "./job-log-redis.js";

const log = createLogger("ws");

/** @type {Map<string, Set<import("ws").WebSocket>>} tenantId -> connections */
const tenantClients = new Map();

/** @type {import("ws").WebSocketServer | null} */
let wss = null;

/** @type {import("redis").RedisClientType | null} */
let redisSub = null;

const HEARTBEAT_MS = 30_000;
const JWT_SECRET = () => process.env.JWT_SECRET || "dev-secret";

function authenticateToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET());
    if (!payload.tenantId) return null;
    return { tenantId: payload.tenantId, userId: payload.userId, email: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Broadcast an event to all WebSocket clients of a tenant.
 * @param {string} tenantId
 * @param {object} event  — must have a `type` field
 */
export function broadcast(tenantId, event) {
  const clients = tenantClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

/**
 * Initialise the WebSocket server on the given HTTP server.
 * @param {import("http").Server} server
 */
export async function initWsHub(server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const auth = token ? authenticateToken(token) : null;

    if (!auth) {
      ws.close(4001, "Unauthorized");
      return;
    }

    ws._tenantId = auth.tenantId;
    ws._alive = true;

    if (!tenantClients.has(auth.tenantId)) {
      tenantClients.set(auth.tenantId, new Set());
    }
    tenantClients.get(auth.tenantId).add(ws);

    log.debug("WS connected", { tenant: auth.tenantId.slice(0, 8) });

    ws.on("pong", () => { ws._alive = true; });

    ws.on("close", () => {
      const set = tenantClients.get(auth.tenantId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) tenantClients.delete(auth.tenantId);
      }
    });

    ws.on("error", () => {
      ws.terminate();
    });
  });

  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws._alive) {
        ws.terminate();
        continue;
      }
      ws._alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));

  await subscribeRedisJobEvents();
  log.info("WebSocket hub pronto", { path: "/ws" });
}

async function subscribeRedisJobEvents() {
  try {
    const base = createClient({ url: getRedisUrl() });
    base.on("error", (err) => log.warn("Redis sub error", { error: err.message }));
    await base.connect();
    redisSub = base;

    await redisSub.pSubscribe("aifactory:job:*:live", (message, channel) => {
      try {
        const event = JSON.parse(message);
        const jobId = channel.replace("aifactory:job:", "").replace(":live", "");
        routeJobEvent(jobId, event);
      } catch {
        /* malformed message */
      }
    });

    log.debug("Redis pSubscribe activo", { pattern: "aifactory:job:*:live" });
  } catch (err) {
    log.warn("Redis subscribe falhou — job events sem WS push", { error: err.message });
  }
}

/** @type {Map<string, string>} jobId -> tenantId */
const jobTenantCache = new Map();
const JOB_CACHE_MAX = 500;

/**
 * @param {string} jobId
 * @param {string} tenantId
 */
export function registerJobTenant(jobId, tenantId) {
  if (jobTenantCache.size > JOB_CACHE_MAX) {
    const firstKey = jobTenantCache.keys().next().value;
    jobTenantCache.delete(firstKey);
  }
  jobTenantCache.set(jobId, tenantId);
}

function routeJobEvent(jobId, event) {
  const tenantId = jobTenantCache.get(jobId);
  if (!tenantId) return;

  const wsEvent = { ...event, jobId };
  if (event.type === "line") {
    wsEvent.type = "job:log";
  } else if (event.type === "exit") {
    wsEvent.type = "job:exit";
  } else if (event.type === "status") {
    wsEvent.type = "job:status";
  } else if (event.type === "dashboard") {
    wsEvent.type = "dashboard";
  } else if (event.type === "reset") {
    wsEvent.type = "job:reset";
  } else {
    wsEvent.type = `job:${event.type}`;
  }

  broadcast(tenantId, wsEvent);
}

export async function closeWsHub() {
  if (redisSub) {
    try { await redisSub.quit(); } catch { /* ignore */ }
    redisSub = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  tenantClients.clear();
  jobTenantCache.clear();
}
