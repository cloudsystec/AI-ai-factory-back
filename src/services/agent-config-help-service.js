import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { query } from "../db/pool.js";
import { allRoleKeys } from "../lib/agent-roles.js";
import {
  assertMacroHelpReady,
  getMacroHelpStatus,
} from "./macro-help-service.js";
import { getFirstReadyBot } from "./worker-bot-service.js";
import {
  registerAiCall,
  endAiCall,
} from "./billing-call-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = "agents/agent-config-help.md";
const AGENT_NAME = "AgentConfigHelp";
const TIMEOUT_MS = Number(process.env.AGENT_CONFIG_HELP_TIMEOUT_MS || 120_000);
const MODEL_ID = String(process.env.AGENT_CONFIG_HELP_MODEL || "composer-2.5").trim();

/** @alias */
export { getMacroHelpStatus as getAgentConfigHelpStatus };

function readAgentPrompt() {
  const agentPath = path.join(__dirname, "../../", AGENT_FILE);
  return fs.readFileSync(agentPath, "utf-8");
}

/**
 * @param {string} raw
 */
export function parseAgentConfigHelpResponse(raw) {
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
      const agentContent = String(parsed.agentContent ?? "").trim();
      const assistantMessage = String(
        parsed.assistantMessage ?? parsed.message ?? ""
      ).trim();
      if (!agentContent) {
        throw new Error("agentContent ausente");
      }
      return {
        agentContent,
        assistantMessage: assistantMessage || "Prompt atualizado.",
      };
    } catch {
      /* try next */
    }
  }

  throw Object.assign(
    new Error("Não foi possível interpretar a resposta da IA."),
    { status: 502 }
  );
}

/**
 * @param {{
 *   roleKey: string,
 *   currentContent: string,
 *   messages: Array<{ role: string, content: string }>,
 *   projectName?: string,
 *   projectSlug?: string,
 * }} input
 */
function buildAgentConfigHelpPrompt(input) {
  const agentRules = readAgentPrompt();
  const history = (input.messages || [])
    .map((m) => `${m.role === "assistant" ? "Assistente" : "Utilizador"}: ${m.content}`)
    .join("\n\n");

  const contextLines = [];
  if (input.projectName) contextLines.push(`Nome do projeto: ${input.projectName}`);
  if (input.projectSlug) contextLines.push(`Slug: ${input.projectSlug}`);
  contextLines.push(`Papel do agente alvo: ${input.roleKey}`);

  return `${agentRules}

---

${contextLines.join("\n")}

Prompt atual do agente (${input.roleKey}):
${input.currentContent?.trim() || "(vazio — ajude o utilizador a criar um prompt do zero)"}

Histórico da conversa:
${history || "(primeira mensagem)"}

Gere o prompt completo atualizado e uma mensagem breve para o utilizador. Responda apenas com JSON conforme especificado.`;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string|null} userId
 */
async function createAgentConfigHelpJob(tenantId, projectSlug, userId) {
  const id = randomUUID();
  await query(
    `INSERT INTO jobs (
       id, tenant_id, project_slug, kind, status, started_at, finished_at, requested_by_user_id
     ) VALUES ($1, $2, $3, 'agent-config-help', 'completed', now(), now(), $4)`,
    [id, tenantId, projectSlug, userId || null]
  );
  return id;
}

/**
 * @param {string} prompt
 * @param {string} apiKey
 */
async function runCursorPrompt(prompt, apiKey) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-help-"));
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const result = await Agent.prompt(prompt, {
        apiKey,
        model: { id: MODEL_ID },
        local: { cwd: tmpDir },
      });

      if (result.status === "error" || result.status === "cancelled") {
        throw Object.assign(
          new Error(`Chamada IA falhou (${result.status}).`),
          { status: 502 }
        );
      }

      return String(result.result ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * @param {string} tenantId
 * @param {string|null} userId
 * @param {string} projectSlug
 * @param {{
 *   roleKey?: string,
 *   currentContent?: string,
 *   messages?: Array<{ role: string, content: string }>,
 *   projectName?: string,
 * }} body
 */
export async function runAgentConfigHelpChat(tenantId, userId, projectSlug, body) {
  await assertMacroHelpReady(tenantId);

  const roleKey = String(body.roleKey ?? "").trim();
  if (!allRoleKeys().includes(roleKey)) {
    throw Object.assign(new Error(`role_key inválido: ${roleKey}`), { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content?.trim()) {
    throw Object.assign(new Error("Mensagem do utilizador é obrigatória."), {
      status: 400,
    });
  }

  const bot = await getFirstReadyBot(tenantId);
  if (!bot) {
    throw Object.assign(
      new Error("Nenhum bot configurado."),
      { status: 403, code: "bot_not_configured" }
    );
  }

  const jobId = await createAgentConfigHelpJob(tenantId, projectSlug, userId);
  const callId = randomUUID();
  const startedAtMs = Date.now();

  await registerAiCall(tenantId, jobId, {
    callId,
    agentFile: AGENT_FILE,
    agentName: AGENT_NAME,
    startedAtMs,
    botEmail: bot.botEmail,
    meta: { source: "agent-config-help", projectSlug, roleKey },
  });

  let rawResponse;
  try {
    const prompt = buildAgentConfigHelpPrompt({
      roleKey,
      currentContent: String(body.currentContent ?? ""),
      messages,
      projectName: body.projectName,
      projectSlug,
    });
    rawResponse = await runCursorPrompt(prompt, bot.apiKey);
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

  return parseAgentConfigHelpResponse(rawResponse);
}
