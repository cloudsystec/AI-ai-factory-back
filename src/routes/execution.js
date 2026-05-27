import { Router } from "express";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
} from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  startContinuousExecution,
  pauseContinuousExecution,
  addWorkersToExecution,
  getExecutionState,
} from "../services/execution-dispatcher-service.js";
import { assertExecutorCanRunJobs } from "../services/user-service.js";
import { broadcast } from "../lib/ws-hub.js";

export const executionRouter = Router();
executionRouter.use(requireAuth, attachCapabilities, requireActivePlan);

executionRouter.get("/:projectSlug/state", async (req, res) => {
  const projectSlug = String(req.params.projectSlug ?? "").trim();
  if (!isValidProjectSlug(projectSlug)) {
    return res.status(400).json({ error: "projectSlug inválido" });
  }
  const state = await getExecutionState(req.user.tenantId, projectSlug);
  res.json({
    continuousActive: state.continuous_active,
    pauseAfterCurrent: state.pause_after_current,
    selectedWorkerSlots: state.selected_worker_slots || [],
    macroId: state.macro_id,
  });
});

executionRouter.post(
  "/:projectSlug/start",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    const { macroId, workerSlots } = req.body ?? {};
    await assertExecutorCanRunJobs(req.user.id);
    const result = await startContinuousExecution(
      req.user.tenantId,
      projectSlug,
      {
        macroId: macroId || projectSlug,
        workerSlots: Array.isArray(workerSlots) ? workerSlots : [],
        executorUserId: req.user.id,
      }
    );
    broadcast(req.user.tenantId, {
      type: "execution",
      project: projectSlug,
      continuousActive: true,
      pauseAfterCurrent: false,
    });
    res.json(result);
  }
);

executionRouter.post(
  "/:projectSlug/add-workers",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    const { workerSlots } = req.body ?? {};
    if (!Array.isArray(workerSlots) || workerSlots.length === 0) {
      return res.status(400).json({ error: "Selecione pelo menos um worker." });
    }
    try {
      const result = await addWorkersToExecution(
        req.user.tenantId,
        projectSlug,
        workerSlots,
        req.user.id
      );
      broadcast(req.user.tenantId, {
        type: "execution",
        project: projectSlug,
        continuousActive: true,
        pauseAfterCurrent: false,
      });
      res.json(result);
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  }
);

executionRouter.post(
  "/:projectSlug/pause",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    const result = await pauseContinuousExecution(
      req.user.tenantId,
      projectSlug
    );
    broadcast(req.user.tenantId, {
      type: "execution",
      project: projectSlug,
      continuousActive: false,
      pauseAfterCurrent: result.pauseAfterCurrent ?? true,
    });
    res.json(result);
  }
);
