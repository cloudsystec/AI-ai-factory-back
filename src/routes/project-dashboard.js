import { Router } from "express";
import { emptyScopeState } from "../lib/empty-scope-state.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import { requireActivePlan, requireAuth } from "../middleware/auth.js";
import {
  getDevelopSettings,
  getScopeStateSnapshot,
  getTaskDetail,
  getTasksSnapshot,
  setDevelopSettings,
} from "../services/project-dashboard-service.js";

export const projectDashboardRouter = Router();
projectDashboardRouter.use(requireAuth, requireActivePlan);

function parseProject(req, res) {
  const project = req.query.project ?? req.body?.project;
  if (!project || typeof project !== "string" || !isValidProjectSlug(project)) {
    res.status(400).json({ error: "project inválido" });
    return null;
  }
  return project;
}

projectDashboardRouter.get("/scope-state", async (req, res) => {
  const project = parseProject(req, res);
  if (!project) return;
  const state = await getScopeStateSnapshot(req.user.tenantId, project);
  if (!state || typeof state !== "object" || !state.current) {
    return res.json(emptyScopeState(project));
  }
  res.json(state);
});

projectDashboardRouter.get("/develop-settings", async (req, res) => {
  const project = parseProject(req, res);
  if (!project) return;
  res.json(await getDevelopSettings(req.user.tenantId, project));
});

projectDashboardRouter.put("/develop-settings", async (req, res) => {
  const project = parseProject(req, res);
  if (!project) return;
  const { autorun } = req.body ?? {};
  if (typeof autorun !== "boolean") {
    return res.status(400).json({ error: "autorun boolean obrigatório" });
  }
  res.json(await setDevelopSettings(req.user.tenantId, project, autorun));
});

projectDashboardRouter.get("/task-detail", async (req, res) => {
  const project = req.query.project;
  const taskId = req.query.taskId;
  if (
    !project ||
    !isValidProjectSlug(String(project)) ||
    !taskId ||
    typeof taskId !== "string"
  ) {
    return res.status(400).json({ error: "project e taskId obrigatórios" });
  }
  const detail = await getTaskDetail(
    req.user.tenantId,
    String(project),
    String(taskId).trim()
  );
  if (!detail) return res.status(404).json({ error: "Task não encontrada" });
  res.json(detail);
});

projectDashboardRouter.get("/tasks", async (req, res) => {
  const project = parseProject(req, res);
  if (!project) return;
  res.json(await getTasksSnapshot(req.user.tenantId, project));
});
