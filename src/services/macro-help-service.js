import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { query } from "../db/pool.js";
import {
  countBotsReady,
  getFirstReadyBot,
} from "./worker-bot-service.js";
import { getProjectMacroScope } from "./macro-scope-service.js";
import {
  registerAiCall,
  endAiCall,
} from "./billing-call-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = "agents/macro-scope-help.md";
const AGENT_NAME = "MacroHelp";
const TIMEOUT_MS = Number(process.env.MACRO_HELP_TIMEOUT_MS || 120_000);
const MODEL_ID = String(process.env.MACRO_HELP_MODEL || "composer-2.5").trim();

/**
 * @param {string} tenantId
 */
export async function isTenantAdminKeyConfigured(tenantId) {
  const { rows } = await query(
    `SELECT cursor_admin_api_key_encrypted IS NOT NULL AS has_key
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return Boolean(rows[0]?.has_key);
}

/**
 * @param {string} tenantId
 */
export async function getMacroHelpStatus(tenantId) {
  const botReady = (await countBotsReady(tenantId)) > 0;
  const adminKeyConfigured = await isTenantAdminKeyConfigured(tenantId);
  return {
    ready: botReady && adminKeyConfigured,
    botReady,
    adminKeyConfigured,
  };
}

/**
 * @param {string} tenantId
 */
export async function assertMacroHelpReady(tenantId) {
  const status = await getMacroHelpStatus(tenantId);
  if (!status.adminKeyConfigured) {
    throw Object.assign(
      new Error(
        "Chave Admin Cursor não configurada para o tenant. Contate o administrador da plataforma."
      ),
      { status: 403, code: "admin_key_not_configured" }
    );
  }
  if (!status.botReady) {
    throw Object.assign(
      new Error(
        "Nenhum bot configurado. Contate o administrador da plataforma."
      ),
      { status: 403, code: "bot_not_configured" }
    );
  }
}

/** @alias */
export const assertProjectCreationReady = assertMacroHelpReady;

function readAgentPrompt() {
  const agentPath = path.join(__dirname, "../../", AGENT_FILE);
  return fs.readFileSync(agentPath, "utf-8");
}

/**
 * @param {string} raw
 */
export function parseMacroHelpResponse(raw) {
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
      const scopeMd = String(parsed.scopeMd ?? "").trim();
      const assistantMessage = String(
        parsed.assistantMessage ?? parsed.message ?? ""
      ).trim();
      if (!scopeMd) {
        throw new Error("scopeMd ausente");
      }
      return {
        scopeMd,
        assistantMessage: assistantMessage || "Escopo atualizado.",
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
 *   currentScopeMd: string,
 *   messages: Array<{ role: string, content: string }>,
 *   projectName?: string,
 *   projectSlug?: string,
 *   draftSlug?: string,
 * }} input
 */
function buildMacroHelpPrompt(input) {
  const agentRules = readAgentPrompt();
  const history = (input.messages || [])
    .map((m) => `${m.role === "assistant" ? "Assistente" : "Usuário"}: ${m.content}`)
    .join("\n\n");

  const contextLines = [];
  if (input.projectName) contextLines.push(`Nome do projeto: ${input.projectName}`);
  const slug = input.projectSlug || input.draftSlug;
  if (slug) contextLines.push(`Slug: ${slug}`);

  return `${agentRules}

---

${contextLines.length ? `${contextLines.join("\n")}\n\n` : ""}Escopo macro atual:
${input.currentScopeMd?.trim() || "(vazio — ajude o utilizador a criar um escopo do zero)"}

Histórico da conversa:
${history || "(primeira mensagem)"}

Gere o escopo macro completo atualizado e uma mensagem breve para o utilizador. Responda apenas com JSON conforme especificado.`;
}

/**
 * @param {string} tenantId
 * @param {string} projectSlug
 * @param {string|null} userId
 */
async function createMacroHelpJob(tenantId, projectSlug, userId) {
  const id = randomUUID();
  const slug = String(projectSlug || "_macro-help").trim() || "_macro-help";
  await query(
    `INSERT INTO jobs (
       id, tenant_id, project_slug, kind, status, started_at, finished_at, requested_by_user_id
     ) VALUES ($1, $2, $3, 'macro-help', 'completed', now(), now(), $4)`,
    [id, tenantId, slug, userId || null]
  );
  return id;
}

/**
 * @param {string} prompt
 * @param {string} apiKey
 */
async function runCursorPrompt(prompt, apiKey) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "macro-help-"));
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
 * @param {{
 *   currentScopeMd?: string,
 *   messages?: Array<{ role: string, content: string }>,
 *   projectName?: string,
 *   projectSlug?: string,
 *   draftSlug?: string,
 * }} body
 */
export async function runMacroHelpChat(tenantId, userId, body) {
  await assertMacroHelpReady(tenantId);

  const projectSlug = String(body.projectSlug ?? "").trim();
  if (projectSlug) {
    const macro = await getProjectMacroScope(tenantId, projectSlug);
    if (!macro.editable) {
      throw Object.assign(
        new Error(
          "O escopo macro não pode ser editado depois de existirem microescopos."
        ),
        { status: 409, code: "MACRO_SCOPE_LOCKED" }
      );
    }
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser?.content?.trim()) {
    throw Object.assign(new Error("Mensagem do usuário é obrigatória."), {
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

  const projectSlugForJob =
    projectSlug || String(body.draftSlug ?? "").trim() || "_macro-help";
  const jobId = await createMacroHelpJob(tenantId, projectSlugForJob, userId);
  const callId = randomUUID();
  const startedAtMs = Date.now();

  await registerAiCall(tenantId, jobId, {
    callId,
    agentFile: AGENT_FILE,
    agentName: AGENT_NAME,
    startedAtMs,
    botEmail: bot.botEmail,
    meta: { source: "macro-help", projectSlug: projectSlugForJob },
  });

  let rawResponse;
  try {
    const prompt = buildMacroHelpPrompt({
      currentScopeMd: String(body.currentScopeMd ?? ""),
      messages,
      projectName: body.projectName,
      projectSlug,
      draftSlug: body.draftSlug,
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

  return parseMacroHelpResponse(rawResponse);
}
