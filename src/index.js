import "dotenv/config";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { devRouter } from "./routes/dev.js";
import { jobsRouter } from "./routes/jobs.js";
import { projectsRouter } from "./routes/projects.js";
import { handleStripeWebhook } from "./routes/stripe.js";
import { workerRouter } from "./routes/worker.js";
import { projectDashboardRouter } from "./routes/project-dashboard.js";
import { adminRouter } from "./routes/admin.js";
import { tenantUsersRouter } from "./routes/tenant-users.js";
import { projectAgentsRouter } from "./routes/project-agents.js";
import {
  githubRouter,
  handleGitHubInstallCallback,
} from "./routes/github.js";
import { executionRouter } from "./routes/execution.js";
import { createLogger, logHttpRequest } from "./lib/logger.js";
import { initWsHub } from "./lib/ws-hub.js";
import { runMigrations } from "./db/migrate.js";
const log = createLogger("back");
const app = express();
const PORT = Number(process.env.PORT || 4000);
let booted = false;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || true,
    credentials: true,
  })
);

app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => logHttpRequest(req, res, Date.now() - start));
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, booted });
});

app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!booted) {
    res.status(503).json({ ok: false, status: "starting" });
    return;
  }
  next();
});

/** Alias: GitHub App pode estar configurada com /api/auth/github/callback */
app.get("/api/auth/github/callback", handleGitHubInstallCallback);

app.use("/api/auth", authRouter);
app.use("/api/tenant-users", tenantUsersRouter);
app.use("/api/github", githubRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:slug/agents", projectAgentsRouter);
app.use("/api/execution", executionRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/billing", billingRouter);
app.use("/api", projectDashboardRouter);
app.use("/worker", workerRouter);
app.use("/admin", adminRouter);
app.use("/dev", devRouter);
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Rota API não encontrada", method: req.method, path: req.path });
});

const API_BUILD = "git-pr-v2";

const server = createServer(app);

server.listen(PORT, "0.0.0.0", () => {
  log.info("Healthcheck disponível", { port: PORT });
  void boot();
});

async function boot() {
  try {
    await runMigrations();
    await initWsHub(server);
    booted = true;
    log.info("AI Factory API online", {
      url: `http://0.0.0.0:${PORT}`,
      build: API_BUILD,
      ws: "/ws",
      color: process.env.AI_FACTORY_LOG_COLOR !== "0",
    });
    log.info(
      "Billing poller em processo separado — use ai-factory-poller (npm run dev)"
    );
  } catch (err) {
    log.error("Boot falhou", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
