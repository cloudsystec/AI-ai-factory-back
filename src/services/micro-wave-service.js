import fs from "node:fs";
import path from "node:path";
import { query } from "../db/pool.js";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import { allMicroTaskPrsMerged } from "./task-pr-service.js";
import { readTasksState } from "./task-state-service.js";

/**
 * Lê micros do volume (simplificado para gates API).
 * @param {string} tenantId
 * @param {string} projectSlug
 */
function readMicrosFromVolume(tenantId, projectSlug) {
  const microPath = path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "scopes",
    "micro",
    `${projectSlug}.micro.json`
  );
  if (!fs.existsSync(microPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(microPath, "utf-8"));
    if (Array.isArray(raw)) return raw;
    for (const key of ["microscopes", "microScopes", "items"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function readBacklogTasks(tenantId, projectSlug) {
  const bp = path.join(
    tenantWorkspacesDir(tenantId),
    projectSlug,
    "backlog",
    `${projectSlug}.tasks.json`
  );
  if (!fs.existsSync(bp)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(bp, "utf-8"));
    return doc.tasks || [];
  } catch {
    return [];
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
export async function getMicroWaveState(tenantId, projectSlug) {
  const micros = readMicrosFromVolume(tenantId, projectSlug);
  const tasks = readBacklogTasks(tenantId, projectSlug);
  const { rows: releases } = await query(
    `SELECT micro_id, release_status, release_pr_url, release_pr_number, merged_at
     FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, projectSlug]
  );
  const releaseByMicro = new Map(releases.map((r) => [r.micro_id, r]));

  const approved = micros
    .filter((m) => m.approved === true && m.validationStatus === "approved")
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  let openMicro = null;
  for (const m of approved) {
    const rel = releaseByMicro.get(m.id);
    if (rel) continue;
    if (!openMicro && ["open", "integrating", "qa_pending"].includes(m.wavePhase || m.taskDeliveryStatus || "")) {
      openMicro = { ...m, wavePhase: m.wavePhase || m.taskDeliveryStatus || "open", release: null };
      break;
    }
    if (!openMicro && (m.wavePhase || m.taskDeliveryStatus || "locked") !== "locked") {
      openMicro = { ...m, wavePhase: m.wavePhase || m.taskDeliveryStatus || "open", release: null };
      break;
    }
  }

  if (!openMicro) {
    for (const m of approved) {
      const rel = releaseByMicro.get(m.id);
      if (rel) continue;
      const prevDone = approved
        .filter((x) => (x.priority ?? 999) < (m.priority ?? 999))
        .every((x) => releaseByMicro.has(x.id));
      if (prevDone || approved.indexOf(m) === 0) {
        openMicro = {
          ...m,
          wavePhase: m.taskDeliveryStatus === "open" ? "open" : "locked",
          release: null,
        };
        break;
      }
    }
  }

  return {
    micros: approved.map((m) => ({
      id: m.id,
      title: m.title,
      taskDeliveryStatus: m.taskDeliveryStatus,
      wavePhase: releaseByMicro.has(m.id)
        ? "released"
        : m.wavePhase || m.taskDeliveryStatus,
      release: releaseByMicro.get(m.id) || null,
    })),
    openMicroId: openMicro?.id || null,
    openMicro,
    taskCountByMicro: Object.fromEntries(
      approved.map((m) => [
        m.id,
        tasks.filter((t) => t.sourceMicroId === m.id).length,
      ])
    ),
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {{ kind: string, taskId?: string, macroId?: string }} opts
 */
export async function assertMicroWaveAllowsJob(tenantId, projectSlug, opts) {
  const kind = opts.kind;
  if (kind === "provision" || kind === "tech-lead-review" || kind === "micro-integration-qa" || kind === "micro-release") {
    return;
  }

  const wave = await getMicroWaveState(tenantId, projectSlug);
  const openId = wave.openMicroId;

  if (kind === "scope") {
    return;
  }

  if (kind === "scope-tasks-only") {
    if (!openId) {
      throw Object.assign(
        new Error("Nenhum micro em onda aberta para gerar tasks."),
        { status: 400, code: "no_open_micro" }
      );
    }
    const om = wave.openMicro;
    if (om?.wavePhase && !["open"].includes(om.wavePhase) && om.taskDeliveryStatus !== "open") {
      throw Object.assign(
        new Error(`Micro ${openId} não está em fase de desenvolvimento (open).`),
        { status: 400, code: "micro_not_open" }
      );
    }
    return;
  }

  if (kind === "task" || kind === "develop") {
    if (!openId) {
      throw Object.assign(
        new Error("Aguarde o release do micro anterior em default antes de novas tasks."),
        { status: 400, code: "micro_locked" }
      );
    }
    if (opts.taskId) {
      const tasks = readBacklogTasks(tenantId, projectSlug);
      const task = tasks.find((t) => t.id === opts.taskId);
      if (task?.sourceMicroId && task.sourceMicroId !== openId) {
        throw Object.assign(
          new Error(
            `Task ${opts.taskId} pertence ao micro ${task.sourceMicroId}; apenas o micro ativo (${openId}) pode ser desenvolvido.`
          ),
          { status: 400, code: "wrong_micro" }
        );
      }
    }
  }
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string} microId
 */
export async function checkMicroReadyForIntegrationQa(
  tenantId,
  projectSlug,
  microId
) {
  const { rows: relRows } = await query(
    `SELECT 1 FROM micro_releases WHERE tenant_id = $1 AND project_slug = $2 AND micro_id = $3`,
    [tenantId, projectSlug, microId]
  );
  if (relRows.length > 0) return false;

  const tasks = readBacklogTasks(tenantId, projectSlug).filter(
    (t) => t.sourceMicroId === microId
  );
  if (tasks.length === 0) return false;

  const runtimeState = readTasksState(tenantId, projectSlug);
  const stateById = new Map(runtimeState.map((t) => [t.id, t]));
  const allDone = tasks.every((t) => {
    const rt = stateById.get(t.id);
    return rt?.status === "done" || t.status === "done";
  });
  if (!allDone) return false;

  return allMicroTaskPrsMerged(tenantId, projectSlug, microId);
}
