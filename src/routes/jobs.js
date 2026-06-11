import { Router } from "express";
import jwt from "jsonwebtoken";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";
import { getCapabilitiesForUser, loadSessionUser } from "../services/user-service.js";
import { isUserLocked } from "../services/password-security-service.js";
import { requireCapability } from "../middleware/permissions.js";
import { assertExecutorCanRunJobs } from "../services/user-service.js";
import { assertAtLeastOneBotReady } from "../services/worker-bot-service.js";
import {
  readJobLogFull,
  subscribeJobLogLive,
} from "../lib/job-log-redis.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  completeJob,
  getActiveJobForTenant,
  getJobById,
  getJobForWorkerSlot,
  getJobLogs,
  getLatestJobForProject,
  parseWorkerSlot,
  queueJob,
} from "../services/job-service.js";
import { query } from "../db/pool.js";
import { broadcast, registerJobTenant } from "../lib/ws-hub.js";

function jobToJson(row) {
  if (!row) return null;
  const workerSlot =
    row.worker_slot != null
      ? Number(row.worker_slot)
      : row.worker_id
        ? parseWorkerSlot(row.worker_id)
        : null;
  return {
    id: row.id,
    kind: row.kind,
    project: row.project_slug,
    macroId: row.macro_id ?? null,
    taskId: row.task_id ?? null,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    exitCode: row.exit_code ?? null,
    workerSlot: Number.isFinite(workerSlot) ? workerSlot : null,
  };
}

async function jobToJsonWithSlot(row) {
  if (!row) return null;
  if (row.worker_slot != null || !row.id) return jobToJson(row);
  const { rows } = await query(
    `SELECT worker_slot FROM work_locks WHERE job_id = $1 LIMIT 1`,
    [row.id]
  );
  return jobToJson({ ...row, worker_slot: rows[0]?.worker_slot ?? null });
}

export const jobsRouter = Router();
jobsRouter.use(requireAuth, requirePasswordReady, attachCapabilities, requireActivePlan);

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const LOG_POLL_MS = 2000;

function countLogLines(text) {
  if (!text) return 0;
  return text.split("\n").length;
}

jobsRouter.post("/", requireCapability("execute"), async (req, res) => {
  try {
    await assertExecutorCanRunJobs(req.user.id);
    await assertAtLeastOneBotReady(req.user.tenantId);
    const result = await queueJob(req.user.tenantId, req.body ?? {}, {
      requestedByUserId: req.user.id,
    });
    registerJobTenant(result.jobId, req.user.tenantId);
    broadcast(req.user.tenantId, {
      type: "job:status",
      jobId: result.jobId,
      status: "queued",
      kind: result.kind,
    });
    res.status(201).json({
      jobId: result.jobId,
      kind: result.kind,
      macroId: result.macroId,
    });
  } catch (error) {
    const status = error.status || 400;
    res.status(status).json({
      error: error.message,
      code: error.code,
    });
  }
});

jobsRouter.get("/active", async (req, res) => {
  const job = await getActiveJobForTenant(req.user.tenantId);
  res.json({ job: jobToJson(job) });
});

jobsRouter.get("/latest", async (req, res) => {
  const project = String(req.query.project ?? "").trim();
  if (!project || !isValidProjectSlug(project)) {
    return res.status(400).json({ error: "query project obrigatório (slug válido)" });
  }
  const job = await getLatestJobForProject(req.user.tenantId, project);
  res.json({ job: await jobToJsonWithSlot(job) });
});

jobsRouter.get("/by-slot", async (req, res) => {
  const project = String(req.query.project ?? "").trim();
  const workerSlot = Number(req.query.slot);
  if (!project || !isValidProjectSlug(project)) {
    return res.status(400).json({ error: "query project obrigatório (slug válido)" });
  }
  if (!Number.isInteger(workerSlot) || workerSlot < 1) {
    return res.status(400).json({ error: "query slot inválido" });
  }
  const job = await getJobForWorkerSlot(
    req.user.tenantId,
    project,
    workerSlot
  );
  res.json({ job: jobToJson(job) });
});

jobsRouter.get("/:id/log", async (req, res) => {
  const job = await getJobById(req.params.id);
  if (!job || job.tenant_id !== req.user.tenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  const text = await getJobLogs(req.params.id);
  res.type("text/plain").send(text);
});

async function authFromQueryOrHeader(req, res, next) {
  if (req.headers.authorization) {
    return requireAuth(req, res, () =>
      requirePasswordReady(req, res, () => requireActivePlan(req, res, next))
    );
  }
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Token obrigatório" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    if (payload.userId) {
      const user = await loadSessionUser(payload.userId);
      if (!user) {
        return res.status(401).json({ error: "Usuário inválido" });
      }
      if (isUserLocked(user)) {
        return res.status(403).json({
          error: "Conta bloqueada. Contate o auditor da sua empresa.",
          code: "account_locked",
        });
      }
      req.user = {
        id: user.id,
        email: user.email,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name || "",
        role: user.role,
        tutorialPending: Boolean(user.tutorial_pending),
        passwordMustChange: Boolean(user.password_must_change),
      };
      req.capabilities = await getCapabilitiesForUser(user.id);
    } else {
      req.user = {
        id: null,
        email: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        passwordMustChange: false,
      };
    }
    return requirePasswordReady(req, res, () => requireActivePlan(req, res, next));
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

jobsRouter.get("/:id/events", authFromQueryOrHeader, async (req, res) => {
  const jobId = req.params.id;
  const job = await getJobById(jobId);
  if (!job || job.tenant_id !== req.user.tenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }

  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (payload) => {
    if (!closed) {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  };

  let closed = false;
  let seenLineCount = 0;
  let unsubscribe = async () => {};

  const pushSnapshot = async () => {
    try {
      const snapshot = await readJobLogFull(jobId);
      seenLineCount = countLogLines(snapshot);
      send({ type: "snapshot", text: snapshot });
      return snapshot;
    } catch (e) {
      console.warn(`[jobs/events] snapshot job=${jobId}:`, e.message);
      send({ type: "snapshot", text: "" });
      seenLineCount = 0;
      return "";
    }
  };

  const finish = async (exitPayload) => {
    if (closed) return;
    closed = true;
    clearInterval(statusPoll);
    clearInterval(logPoll);
    clearInterval(heartbeat);
    try {
      await pushSnapshot();
    } catch {
      /* ignore */
    }
    if (exitPayload) send(exitPayload);
    try {
      await unsubscribe();
    } catch {
      /* ignore */
    }
    res.end();
  };

  send({ type: "status", status: job.status });
  await pushSnapshot();

  try {
    unsubscribe = await subscribeJobLogLive(jobId, {
      onMessage: (event) => {
        if (closed) return;
        if (event.type === "reset") {
          seenLineCount = 0;
          send({ type: "reset" });
        } else if (event.type === "line" && typeof event.text === "string") {
          const seq = event.seq;
          if (typeof seq === "number" && seq < seenLineCount) {
            return;
          }
          if (typeof seq === "number") {
            seenLineCount = Math.max(seenLineCount, seq + 1);
          } else {
            seenLineCount += 1;
          }
          send({
            type: "line",
            stream: event.stream || "stdout",
            text: event.text,
            seq: event.seq,
          });
        } else if (event.type === "exit") {
          send({
            type: "exit",
            code: event.code ?? null,
            signal: event.signal ?? null,
          });
        } else if (event.type === "dashboard") {
          send({ type: "dashboard" });
        } else if (event.type === "status" && event.status) {
          send({ type: "status", status: event.status });
        }
      },
      onError: (err) => {
        console.warn(`[jobs/events] redis job=${jobId}:`, err.message);
      },
    });
  } catch (e) {
    console.warn(`[jobs/events] subscribe job=${jobId}:`, e.message);
  }

  const logPoll = setInterval(() => {
    if (closed) return;
    pushSnapshot().catch(() => {});
  }, LOG_POLL_MS);

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(": ping\n\n");
  }, 15000);

  let lastPolledStatus = job.status;
  const statusPoll = setInterval(async () => {
    if (closed) return;
    try {
      const fresh = await getJobById(jobId);
      if (!fresh || fresh.status === lastPolledStatus) return;
      lastPolledStatus = fresh.status;
      send({ type: "status", status: fresh.status });
      if (TERMINAL_STATUSES.has(fresh.status)) {
        await finish({
          type: "exit",
          code: fresh.exit_code ?? null,
          signal: null,
        });
      }
    } catch {
      /* ignore */
    }
  }, 1000);

  req.on("close", () => {
    closed = true;
    clearInterval(statusPoll);
    clearInterval(logPoll);
    clearInterval(heartbeat);
    unsubscribe().catch(() => {});
  });
});

jobsRouter.post("/:id/cancel", requireCapability("execute"), async (_req, res) => {
  res.status(403).json({
    error:
      "Cancelamento de jobs desativado. Os workers terminam o trabalho atual; use Pause na execução contínua.",
    code: "cancel_disabled",
  });
});

jobsRouter.get("/:id", async (req, res) => {
  const job = await getJobById(req.params.id);
  if (!job || job.tenant_id !== req.user.tenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  res.json({ job: await jobToJsonWithSlot(job) });
});
