import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { query } from "../db/pool.js";
import { isValidProjectSlug } from "../lib/project-slug.js";
import {
  assertMacroHelpReady,
  runCursorPrompt,
} from "./macro-help-service.js";
import { getFirstReadyBot } from "./worker-bot-service.js";
import {
  registerAiCall,
  endAiCall,
} from "./billing-call-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_FILE = "agents/project-discovery.md";
const AGENT_NAME = "ProjectDiscovery";

/** @type {readonly string[]} */
export const DISCOVERY_TOPIC_KEYS = [
  "problem",
  "personas",
  "mustHaveFeatures",
  "outOfScope",
  "deliveryFormat",
  "backend",
  "frontend",
  "persistence",
  "authSecurity",
  "integrations",
  "nfrs",
  "successCriteria",
  "projectName",
  "projectSlug",
];

export const DISCOVERY_TOPIC_LABELS = {
  problem: "Problema e objetivo",
  personas: "Utilizadores / personas",
  mustHaveFeatures: "Funcionalidades must-have",
  outOfScope: "Fora de escopo",
  deliveryFormat: "Formato de entrega",
  backend: "Backend",
  frontend: "Frontend",
  persistence: "Persistência",
  authSecurity: "Auth e segurança",
  integrations: "Integrações externas",
  nfrs: "Requisitos não funcionais",
  successCriteria: "Critérios de sucesso",
  projectName: "Nome do projeto",
  projectSlug: "Slug do projeto",
};

function readAgentPrompt() {
  const agentPath = path.join(__dirname, "../../", AGENT_FILE);
  return fs.readFileSync(agentPath, "utf-8");
}

/**
 * @param {unknown} decisions
 */
export function allDiscoveryDecisionsResolved(decisions) {
  if (!decisions || typeof decisions !== "object") return false;
  return DISCOVERY_TOPIC_KEYS.every((key) => {
    const entry = /** @type {Record<string, { resolved?: boolean, value?: string }>} */ (
      decisions
    )[key];
    return (
      entry?.resolved === true && String(entry.value ?? "").trim().length > 0
    );
  });
}

/**
 * @param {string} raw
 */
export function parseDiscoveryResponse(raw) {
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

      const decisions =
        parsed.decisions && typeof parsed.decisions === "object"
          ? parsed.decisions
          : {};

      const openTopics = Array.isArray(parsed.openTopics)
        ? parsed.openTopics.map(String)
        : [];

      let readyToCreate = parsed.readyToCreate === true;
      const proposedName = parsed.proposedName
        ? String(parsed.proposedName).trim()
        : null;
      const proposedSlug = parsed.proposedSlug
        ? String(parsed.proposedSlug).trim()
        : null;
      const scopeMd = parsed.scopeMd ? String(parsed.scopeMd).trim() : null;

      if (readyToCreate) {
        if (
          !allDiscoveryDecisionsResolved(decisions) ||
          !proposedName ||
          !proposedSlug ||
          !scopeMd ||
          !isValidProjectSlug(proposedSlug)
        ) {
          readyToCreate = false;
        }
      }

      return {
        assistantMessage,
        phase: readyToCreate ? "ready" : String(parsed.phase || "discovery"),
        readyToCreate,
        decisions,
        openTopics: readyToCreate ? [] : openTopics,
        proposedName: readyToCreate ? proposedName : null,
        proposedSlug: readyToCreate ? proposedSlug : null,
        scopeMd: readyToCreate ? scopeMd : null,
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
 * @param {Array<{ role: string, content: string }>} messages
 * @param {object} decisions
 * @param {{ bootstrap?: boolean }} [opts]
 */
function buildDiscoveryPrompt(messages, decisions, opts = {}) {
  const agentRules = readAgentPrompt();
  const history = (messages || [])
    .map((m) => `${m.role === "assistant" ? "Assistente" : "Operador"}: ${m.content}`)
    .join("\n\n");

  const bootstrapNote = opts.bootstrap
    ? "\n\nEsta é a **primeira interação** da sessão. Apresente-se brevemente como PO/SM e faça a **primeira pergunta** da checklist (problema/objetivo). Não assuma nada."
    : "";

  return `${agentRules}

---

Decisões registadas até agora:
${JSON.stringify(decisions || {}, null, 2)}

Histórico da conversa:
${history || "(ainda sem mensagens do operador)"}${bootstrapNote}

Responda apenas com JSON conforme especificado.`;
}

/**
 * @param {string} tenantId
 * @param {string|null} userId
 */
async function createDiscoveryJob(tenantId, userId) {
  const id = randomUUID();
  await query(
    `INSERT INTO jobs (
       id, tenant_id, project_slug, kind, status, started_at, finished_at, requested_by_user_id
     ) VALUES ($1, $2, '_project-discovery', 'project-discovery', 'completed', now(), now(), $3)`,
    [id, tenantId, userId || null]
  );
  return id;
}

/**
 * @param {string} tenantId
 * @param {string|null} userId
 * @param {Array<{ role: string, content: string }>} messages
 * @param {object} decisions
 * @param {{ bootstrap?: boolean }} [opts]
 */
async function callDiscoveryAgent(tenantId, userId, messages, decisions, opts = {}) {
  const bot = await getFirstReadyBot(tenantId);
  if (!bot) {
    throw Object.assign(
      new Error("Nenhum bot configurado."),
      { status: 403, code: "bot_not_configured" }
    );
  }

  const jobId = await createDiscoveryJob(tenantId, userId);
  const callId = randomUUID();
  const startedAtMs = Date.now();

  await registerAiCall(tenantId, jobId, {
    callId,
    agentFile: AGENT_FILE,
    agentName: AGENT_NAME,
    startedAtMs,
    botEmail: bot.botEmail,
    meta: { source: "project-discovery" },
  });

  let rawResponse;
  try {
    const prompt = buildDiscoveryPrompt(messages, decisions, opts);
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

  return parseDiscoveryResponse(rawResponse);
}

/**
 * @param {object} row
 */
function sessionToPayload(row) {
  const decisions = row.decisions || {};
  const resolvedCount = DISCOVERY_TOPIC_KEYS.filter(
    (k) => decisions[k]?.resolved === true
  ).length;

  return {
    sessionId: row.id,
    status: row.status,
    messages: row.messages || [],
    decisions,
    openTopics: row.open_topics || [],
    readyToCreate: row.status === "ready",
    proposedName: row.proposed_name,
    proposedSlug: row.proposed_slug,
    scopeMd: row.scope_md,
    progress: {
      resolved: resolvedCount,
      total: DISCOVERY_TOPIC_KEYS.length,
    },
    topicLabels: DISCOVERY_TOPIC_LABELS,
  };
}

/**
 * @param {string} tenantId
 * @param {string|null} userId
 */
export async function createDiscoverySession(tenantId, userId) {
  await assertMacroHelpReady(tenantId);

  const sessionId = randomUUID();
  const parsed = await callDiscoveryAgent(tenantId, userId, [], {}, {
    bootstrap: true,
  });

  const messages = [{ role: "assistant", content: parsed.assistantMessage }];
  const status = parsed.readyToCreate ? "ready" : "in_progress";

  await query(
    `INSERT INTO project_discovery_sessions (
       id, tenant_id, user_id, status, messages, decisions, open_topics,
       proposed_name, proposed_slug, scope_md
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      sessionId,
      tenantId,
      userId,
      status,
      JSON.stringify(messages),
      JSON.stringify(parsed.decisions),
      JSON.stringify(parsed.openTopics),
      parsed.proposedName,
      parsed.proposedSlug,
      parsed.scopeMd,
    ]
  );

  const { rows } = await query(
    `SELECT * FROM project_discovery_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  );

  return sessionToPayload(rows[0]);
}

/**
 * @param {string} tenantId
 * @param {string} sessionId
 */
export async function getDiscoverySession(tenantId, sessionId) {
  const { rows } = await query(
    `SELECT * FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status != 'consumed'`,
    [sessionId, tenantId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Sessão de descoberta não encontrada."), {
      status: 404,
    });
  }
  return sessionToPayload(rows[0]);
}

/**
 * @param {string} tenantId
 * @param {string|null} userId
 * @param {string} sessionId
 * @param {string} userMessage
 */
export async function runDiscoveryChat(tenantId, userId, sessionId, userMessage) {
  await assertMacroHelpReady(tenantId);

  const trimmed = String(userMessage ?? "").trim();
  if (!trimmed) {
    throw Object.assign(new Error("Mensagem é obrigatória."), { status: 400 });
  }

  const { rows } = await query(
    `SELECT * FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status != 'consumed'
     FOR UPDATE`,
    [sessionId, tenantId]
  );
  const session = rows[0];
  if (!session) {
    throw Object.assign(new Error("Sessão de descoberta não encontrada."), {
      status: 404,
    });
  }
  if (session.status === "ready") {
    throw Object.assign(
      new Error("Sessão já está pronta — crie o projeto ou inicie nova sessão."),
      { status: 409 }
    );
  }

  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  messages.push({ role: "user", content: trimmed });

  const parsed = await callDiscoveryAgent(
    tenantId,
    userId,
    messages,
    session.decisions || {}
  );

  messages.push({ role: "assistant", content: parsed.assistantMessage });

  const status = parsed.readyToCreate ? "ready" : "in_progress";

  await query(
    `UPDATE project_discovery_sessions SET
       status = $3,
       messages = $4::jsonb,
       decisions = $5::jsonb,
       open_topics = $6::jsonb,
       proposed_name = $7,
       proposed_slug = $8,
       scope_md = $9,
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [
      sessionId,
      tenantId,
      status,
      JSON.stringify(messages),
      JSON.stringify(parsed.decisions),
      JSON.stringify(parsed.openTopics),
      parsed.proposedName,
      parsed.proposedSlug,
      parsed.scopeMd,
    ]
  );

  return getDiscoverySession(tenantId, sessionId);
}

/**
 * @param {string} tenantId
 * @param {string} sessionId
 */
export async function assertSessionReady(tenantId, sessionId) {
  const { rows } = await query(
    `SELECT * FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status = 'ready'`,
    [sessionId, tenantId]
  );
  const session = rows[0];
  if (!session) {
    throw Object.assign(
      new Error(
        "Sessão de descoberta inválida ou incompleta. Conclua o brainstorm no chat antes de criar o projeto."
      ),
      { status: 400, code: "discovery_not_ready" }
    );
  }

  const name = String(session.proposed_name ?? "").trim();
  const slug = String(session.proposed_slug ?? "").trim();
  const scope = String(session.scope_md ?? "").trim();

  if (!name || !slug || !scope || !isValidProjectSlug(slug)) {
    throw Object.assign(
      new Error("Sessão de descoberta sem nome, slug ou escopo válidos."),
      { status: 400, code: "discovery_invalid_payload" }
    );
  }

  if (!allDiscoveryDecisionsResolved(session.decisions)) {
    throw Object.assign(
      new Error("Ainda há decisões em aberto na sessão de descoberta."),
      { status: 400, code: "discovery_incomplete" }
    );
  }

  return { name, slug, scope };
}

/**
 * @param {string} tenantId
 * @param {string} sessionId
 */
export async function consumeDiscoverySession(tenantId, sessionId) {
  await query(
    `UPDATE project_discovery_sessions SET status = 'consumed', updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId]
  );
}

/**
 * @param {string} tenantId
 * @param {string} sessionId
 */
export async function deleteDiscoverySession(tenantId, sessionId) {
  const { rowCount } = await query(
    `DELETE FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status != 'consumed'`,
    [sessionId, tenantId]
  );
  if (!rowCount) {
    throw Object.assign(new Error("Sessão não encontrada."), { status: 404 });
  }
}
