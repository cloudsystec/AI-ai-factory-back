import { Router } from "express";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
  requirePasswordReady,
} from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  startContinuousExecution,
  pauseContinuousExecution,
  addWorkersToExecution,
  getExecutionState,
  startWorkerSlot,
  stopWorkerSlot,
  startAllReadyWorkers,
} from "../services/execution-dispatcher-service.js";
import { assertExecutorCanRunJobs } from "../services/user-service.js";
import { assertBotsReadyForSlots } from "../services/worker-bot-service.js";
import { broadcast, broadcastWorkersAndJobs } from "../lib/ws-hub.js";
import { getProjectGitRow } from "../services/project-git-service.js";

export const executionRouter = Router();
executionRouter.use(requireAuth, requirePasswordReady, attachCapabilities, requireActivePlan);

executionRouter.get("/:projectSlug/state", async (req, res) => {
  const projectSlug = String(req.params.projectSlug ?? "").trim();
  if (!isValidProjectSlug(projectSlug)) {
    return res.status(400).json({ error: "projectSlug inválido" });
  }
  const state = await getExecutionState(req.user.tenantId, projectSlug);
  const gitRow = await getProjectGitRow(req.user.tenantId, projectSlug);
  res.json({
    continuousActive: state.continuous_active,
    pauseAfterCurrent: state.pause_after_current,
    selectedWorkerSlots: state.selected_worker_slots || [],
    macroId: state.macro_id,
    gitStatus: gitRow?.git_status ?? null,
    gitLastError: gitRow?.git_last_error ?? null,
    repoMode: gitRow?.github_repo_mode ?? null,
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
    const slots = Array.isArray(workerSlots) ? workerSlots : [];
    await assertBotsReadyForSlots(req.user.tenantId, slots);
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
      continuousActive: result.projectCompleted ? false : true,
      pauseAfterCurrent: false,
      selectedWorkerSlots: result.projectCompleted ? [] : slots,
    });
    broadcastWorkersAndJobs(
      req.user.tenantId,
      projectSlug,
      result.enqueued
    );
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
      await assertBotsReadyForSlots(req.user.tenantId, workerSlots);
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
        selectedWorkerSlots: workerSlots,
      });
      broadcastWorkersAndJobs(
        req.user.tenantId,
        projectSlug,
        result.enqueued
      );
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
      selectedWorkerSlots: result.workerSlots ?? [],
    });
    broadcast(req.user.tenantId, { type: "billing" });
    res.json(result);
  }
);

executionRouter.post(
  "/:projectSlug/play-all",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    try {
      await assertExecutorCanRunJobs(req.user.id);
      const { macroId } = req.body ?? {};
      const result = await startAllReadyWorkers(
        req.user.tenantId,
        projectSlug,
        { macroId: macroId || projectSlug, executorUserId: req.user.id }
      );
      const slots = result.workerSlots ?? [];
      broadcast(req.user.tenantId, {
        type: "execution",
        project: projectSlug,
        continuousActive: result.projectCompleted ? false : true,
        pauseAfterCurrent: false,
        selectedWorkerSlots: result.projectCompleted ? [] : slots,
        action: "play-all",
      });
      broadcastWorkersAndJobs(
        req.user.tenantId,
        projectSlug,
        result.enqueued
      );
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  }
);

executionRouter.post(
  "/:projectSlug/workers/:slot/start",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    const workerSlot = Number(req.params.slot);
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    try {
      await assertExecutorCanRunJobs(req.user.id);
      const { macroId } = req.body ?? {};
      const result = await startWorkerSlot(
        req.user.tenantId,
        projectSlug,
        workerSlot,
        { macroId: macroId || projectSlug, executorUserId: req.user.id }
      );
      const slots = result.workerSlots ?? [workerSlot];
      broadcast(req.user.tenantId, {
        type: "execution",
        project: projectSlug,
        continuousActive: result.projectCompleted ? false : true,
        pauseAfterCurrent: false,
        selectedWorkerSlots: result.projectCompleted ? [] : slots,
        workerSlot,
        action: "start",
      });
      broadcastWorkersAndJobs(
        req.user.tenantId,
        projectSlug,
        result.enqueued
      );
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  }
);

executionRouter.post(
  "/:projectSlug/workers/:slot/stop",
  requireCapability("execute"),
  async (req, res) => {
    const projectSlug = String(req.params.projectSlug ?? "").trim();
    const workerSlot = Number(req.params.slot);
    if (!isValidProjectSlug(projectSlug)) {
      return res.status(400).json({ error: "projectSlug inválido" });
    }
    try {
      const result = await stopWorkerSlot(
        req.user.tenantId,
        projectSlug,
        workerSlot
      );
      broadcast(req.user.tenantId, {
        type: "execution",
        project: projectSlug,
        continuousActive: result.continuousActive === true,
        pauseAfterCurrent: result.pauseAfterCurrent === true,
        selectedWorkerSlots: result.workerSlots ?? [],
        workerSlot,
        action: "stop",
      });
      broadcast(req.user.tenantId, { type: "billing" });
      res.json(result);
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message, code: e.code });
    }
  }
);
