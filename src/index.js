import "dotenv/config";
import cors from "cors";
import express from "express";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { devRouter } from "./routes/dev.js";
import { jobsRouter } from "./routes/jobs.js";
import { projectsRouter } from "./routes/projects.js";
import { stripeRouter } from "./routes/stripe.js";
import { workerRouter } from "./routes/worker.js";
import { projectDashboardRouter } from "./routes/project-dashboard.js";
import { adminRouter } from "./routes/admin.js";
import { tenantUsersRouter } from "./routes/tenant-users.js";
import { projectAgentsRouter } from "./routes/project-agents.js";

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || true,
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/tenant-users", tenantUsersRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/projects/:slug/agents", projectAgentsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/billing", billingRouter);
app.use("/api", projectDashboardRouter);
app.use("/worker", workerRouter);
app.use("/admin", adminRouter);
app.use("/dev", devRouter);
app.use(stripeRouter);

app.listen(PORT, () => {
  console.log(`@ai-factory/back em http://localhost:${PORT}`);
});
