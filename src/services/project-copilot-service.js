import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { query } from "../db/pool.js";
import {
  assertMacroHelpReady,
  getMacroHelpStatus,
  runCursorPrompt,
} from "./macro-help-service.js";
import { getFirstReadyBot } from "./worker-bot-service.js";
import {
  registerAiCall,
  endAiCall,
} from "./billing-call-service.js";
import {
  assertCopilotGuardAllows,
  getCopilotGuardStatus,
} from "./project-copilot-guard.js";
import {
  appendCopilotMessage,
  clearCopilotHistory,
  createPendingAction,
  listCopilotMessages,
  loadPendingAction,
  markPendingActionConfirmed,
} from "./project-copilot-chat-store.js";
import {
  executeConfirmedAction,
  executeCopilotTool,
  READ_TOOLS,
  WRITE_CONFIRM,
  WRITE_IMMEDIATE,
} from "./project-copilot-tools.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  getScopeStateSnapshot,
  getTasksSnapshot,
} from "./project-dashboard-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = "agents/project-copilot.md";
const AGENT_NAME = "ProjectCopilot";
const TIMEOUT_MS = Number(process.env.PROJECT_COPILOT_TIMEOUT_MS || 120_000);
const MODEL_ID = String(process.env.PROJECT_COPILOT_MODEL || "composer-2.5").trim();

/** @alias */
export { getMacroHelpStatus as getProjectCopilotStatus };

function readAgentPrompt() {
  return fs.readFileSync(path.join(__dirname, "../../", AGENT_FILE), "utf-8");
}

/**
 * @param {string} raw
 */
export function parseCopilotResponse(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw Object.assign(new Error("Resposta vazia da IA."), { status: 502 });
  }
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [text];
  if (fenceMatch?.[1]) candidates.unshift(fenceMatch[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const assistantMessage = String(
        parsed.assistantMessage ?? parsed.message ?? ""
      ).trim();
      if (!assistantMessage) {
        throw new Error("assistantMessage ausente");
      }
      return {
        assistantMessage,
        toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [],
        pendingActions: Array.isArray(parsed.pendingActions)
          ? parsed.pendingActions
          : [],
      };
    } catch {
      /* try next */
    }
  }
  throw Object.assign(
    new Error("Não foi possível interpretar a resposta do copiloto."),
    { status: 502 }
  );
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 */
async function assertTenantProject(tenantId, projectSlug) {
  if (!isValidProjectSlug(projectSlug)) {
    throw Object.assign(new Error("Slug inválido"), { status: 400 });
  }
  const { rows } = await query(
    "SELECT slug, name FROM projects WHERE tenant_id = $1 AND slug = $2",
    [tenantId, projectSlug]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Projeto não encontrado"), { status: 404 });
  }
  return rows[0];
}

/**
 * @param {object} input
 */
async function buildProjectContext(input) {
  const [scopeState, tasks, guard] = await Promise.all([
    getScopeStateSnapshot(input.tenantId, input.projectSlug),
    getTasksSnapshot(input.tenantId, input.projectSlug),
    getCopilotGuardStatus(input.tenantId, input.userId),
  ]);
  return {
    projectName: input.projectName,
    projectSlug: input.projectSlug,
    scopeState,
    taskCount: tasks.length,
    guardStrikes: guard.strikes,
  };
}

/**
 * @param {object} input
 * @param {object} context
 * @param {Array<{ role: string, content: string }>} history
 * @param {object[]} toolResults
 */
function buildCopilotPrompt(input, context, history, toolResults) {
  const rules = readAgentPrompt();
  const histText = history
    .map((m) => `${m.role === "assistant" ? "Assistente" : "Usuário"}: ${m.content}`)
    .join("\n\n");
  const toolText =
    toolResults.length > 0
      ? `\n\nResultados de tools já executadas:\n${JSON.stringify(toolResults, null, 2)}`
      : "";

  return `${rules}

---

Projeto: ${context.projectName} (slug: ${context.projectSlug})
Estado resumido: ${JSON.stringify(context.scopeState || {}, null, 2)}
Tasks no painel: ${context.taskCount}
Capabilities: canWrite=${input.capabilities?.canWrite === true}, canExecute=${input.capabilities?.canExecute === true}

Histórico:
${histText || "(primeira mensagem)"}${toolText}

Responda apenas com JSON conforme especificado.`;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string|null} userId
 */
async function createCopilotJob(tenantId, projectSlug, userId) {
  const id = randomUUID();
  await query(
    `INSERT INTO jobs (
       id, tenant_id, project_slug, kind, status, started_at, finished_at, requested_by_user_id
     ) VALUES ($1, $2, $3, 'macro-help', 'completed', now(), now(), $4)`,
    [id, tenantId, projectSlug, userId || null]
  );
  return id;
}

/**
 * @param {object} ctx
 * @param {object} parsed
 */
async function processToolCalls(ctx, parsed) {
  /** @type {object[]} */
  const results = [];
  /** @type {object[]} */
  const pendingActions = [];

  for (const call of parsed.toolCalls || []) {
    const name = String(call?.name ?? "").trim();
    const args = call?.args && typeof call.args === "object" ? call.args : {};

    if (WRITE_CONFIRM.has(name)) {
      pendingActions.push(
        await createPendingAction(
          ctx.tenantId,
          ctx.projectSlug,
          ctx.userId,
          name,
          args,
          `Confirmar: ${name}`
        )
      );
      continue;
    }

    if (WRITE_IMMEDIATE.has(name)) {
      try {
        const out = await executeCopilotTool(ctx, name, args);
        results.push({ name, ok: true, result: out });
      } catch (err) {
        results.push({
          name,
          ok: false,
          error: err.message || String(err),
          code: err.code,
        });
      }
      continue;
    }

    if (READ_TOOLS.has(name)) {
      try {
        const out = await executeCopilotTool(ctx, name, args);
        results.push({ name, ok: true, result: out });
      } catch (err) {
        results.push({
          name,
          ok: false,
          error: err.message || String(err),
          code: err.code,
        });
      }
    }
  }

  for (const action of parsed.pendingActions || []) {
    const type = String(action?.type ?? "").trim();
    if (!WRITE_CONFIRM.has(type)) continue;
    pendingActions.push(
      await createPendingAction(
        ctx.tenantId,
        ctx.projectSlug,
        ctx.userId,
        type,
        action.payload || {},
        String(action.summary ?? type)
      )
    );
  }

  return { results, pendingActions };
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} projectSlug
 * @param {object} capabilities
 * @param {string} message
 */
export async function runProjectCopilotChat(
  tenantId,
  userId,
  projectSlug,
  capabilities,
  message
) {
  await assertMacroHelpReady(tenantId);
  const project = await assertTenantProject(tenantId, projectSlug);
  const text = String(message ?? "").trim();
  if (!text) {
    throw Object.assign(new Error("Mensagem obrigatória."), { status: 400 });
  }

  await assertCopilotGuardAllows(tenantId, userId, text);
  await appendCopilotMessage(tenantId, projectSlug, userId, "user", text);

  const history = await listCopilotMessages(tenantId, projectSlug, userId, 40);
  const ctx = {
    tenantId,
    projectSlug,
    userId,
    capabilities,
  };

  const bot = await getFirstReadyBot(tenantId);
  if (!bot) {
    throw Object.assign(new Error("Nenhum bot configurado."), { status: 403 });
  }

  const jobId = await createCopilotJob(tenantId, projectSlug, userId);
  const callId = randomUUID();
  const startedAtMs = Date.now();
  await registerAiCall(tenantId, jobId, {
    callId,
    agentFile: AGENT_FILE,
    agentName: AGENT_NAME,
    startedAtMs,
    botEmail: bot.botEmail,
    meta: { source: "project-copilot", projectSlug },
  });

  const context = await buildProjectContext({
    tenantId,
    projectSlug,
    userId,
    projectName: project.name,
  });

  let parsed;
  let toolResults = [];
  let pendingActions = [];

  try {
    const prompt = buildCopilotPrompt(
      { ...ctx, capabilities, projectName: project.name },
      context,
      history,
      []
    );
    const raw = await runCursorPrompt(prompt, bot.apiKey);
    parsed = parseCopilotResponse(raw);

    const firstPass = await processToolCalls(ctx, parsed);
    toolResults = firstPass.results;
    pendingActions = firstPass.pendingActions;

    const readCalls = (parsed.toolCalls || []).filter((c) =>
      READ_TOOLS.has(String(c?.name ?? ""))
    );
    if (readCalls.length > 0 && toolResults.length > 0) {
      const followUpPrompt = buildCopilotPrompt(
        { ...ctx, capabilities, projectName: project.name },
        context,
        history,
        toolResults
      );
      const raw2 = await runCursorPrompt(followUpPrompt, bot.apiKey);
      parsed = parseCopilotResponse(raw2);
      const secondPass = await processToolCalls(ctx, parsed);
      pendingActions = [...pendingActions, ...secondPass.pendingActions];
    }
  } catch (err) {
    await endAiCall(tenantId, callId, {
      endedAtMs: Date.now(),
      botEmail: bot.botEmail,
    });
    throw err;
  }

  await endAiCall(tenantId, callId, {
    endedAtMs: Date.now(),
    botEmail: bot.botEmail,
  });

  await appendCopilotMessage(
    tenantId,
    projectSlug,
    userId,
    "assistant",
    parsed.assistantMessage,
    { toolResults, pendingActionIds: pendingActions.map((p) => p.id) }
  );

  return {
    assistantMessage: parsed.assistantMessage,
    toolResults,
    pendingActions,
  };
}

/**
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} projectSlug
 * @param {object} capabilities
 * @param {string} actionId
 */
export async function confirmProjectCopilotAction(
  tenantId,
  userId,
  projectSlug,
  capabilities,
  actionId,
  opts = {}
) {
  await assertMacroHelpReady(tenantId);
  await assertTenantProject(tenantId, projectSlug);

  const pending = await loadPendingAction(
    tenantId,
    projectSlug,
    userId,
    actionId
  );

  const cap =
    pending.actionType === "reset_project" ||
    pending.actionType === "improve_macro_scope" ||
    pending.actionType === "update_micro_scope"
      ? "write"
      : "write";
  if (cap === "write" && !capabilities?.canWrite) {
    throw Object.assign(new Error("Sem permissão de escrita."), { status: 403 });
  }

  const ctx = { tenantId, projectSlug, userId, capabilities };
  const payload =
    pending.actionType === "reset_project" && opts.forceStop === true
      ? { ...pending.payload, forceStop: true }
      : pending.payload;
  const result = await executeConfirmedAction(
    ctx,
    pending.actionType,
    payload
  );
  await markPendingActionConfirmed(actionId);

  await appendCopilotMessage(
    tenantId,
    projectSlug,
    userId,
    "assistant",
    `Ação confirmada: ${pending.summary}`,
    { confirmedActionId: actionId, result }
  );

  return { ok: true, actionType: pending.actionType, result };
}

export { clearCopilotHistory, listCopilotMessages, getCopilotGuardStatus };
