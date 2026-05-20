import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireActivePlan, requireAuth } from "../middleware/auth.js";
import {
  getActiveJobForTenant,
  getJobById,
  getJobLogs,
  queueJob,
} from "../services/job-service.js";

export const jobsRouter = Router();
jobsRouter.use(requireAuth, requireActivePlan);

const VALID_KINDS = new Set([
  "scope",
  "scope-tasks-only",
  "develop",
  "task",
]);

jobsRouter.post("/", async (req, res) => {
  try {
    const result = await queueJob(req.user.tenantId, req.body ?? {});
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
  if (!job) return res.json({ job: null });
  res.json({
    job: {
      id: job.id,
      kind: job.kind,
      project: job.project_slug,
      status: job.status,
      startedAt: job.started_at,
    },
  });
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
    return requireAuth(req, res, () => requireActivePlan(req, res, next));
  }
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Token obrigatório" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    req.user = { email: payload.sub, tenantId: payload.tenantId };
    return requireActivePlan(req, res, next);
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

jobsRouter.get("/:id/events", authFromQueryOrHeader, async (req, res) => {
  const job = await getJobById(req.params.id);
  if (!job || job.tenant_id !== req.user.tenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send({ type: "status", status: job.status });
  const snapshot = await getJobLogs(req.params.id);
  send({ type: "snapshot", text: snapshot });

  let lastId = 0;
  const poll = setInterval(async () => {
    const { query } = await import("../db/pool.js");
    const { rows } = await query(
      "SELECT id, line FROM job_log_lines WHERE job_id = $1 AND id > $2 ORDER BY id",
      [req.params.id, lastId]
    );
    for (const row of rows) {
      lastId = Number(row.id);
      send({ type: "line", stream: "stdout", text: row.line });
    }
    const fresh = await getJobById(req.params.id);
    if (
      fresh &&
      ["succeeded", "failed", "cancelled"].includes(fresh.status)
    ) {
      send({ type: "status", status: fresh.status });
      send({ type: "exit", code: fresh.exit_code, signal: null });
      clearInterval(poll);
      res.end();
    }
  }, 500);

  req.on("close", () => clearInterval(poll));
});

jobsRouter.post("/:id/cancel", async (req, res) => {
  const job = await getJobById(req.params.id);
  if (!job || job.tenant_id !== req.user.tenantId) {
    return res.status(404).json({ error: "Job não encontrado" });
  }
  if (!["queued", "running", "waiting_input"].includes(job.status)) {
    return res.status(400).json({ error: "Job já terminou" });
  }
  const { query } = await import("../db/pool.js");
  await query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = $1", [
    req.params.id,
  ]);
  res.json({ ok: true, status: "cancelled" });
});
