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
 * @param {unknown} messages
 */
export function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => m?.role === "user").length;
}

/**
 * @param {number} n
 */
export function buildDraftProjectIdentity(n) {
  const num = Math.max(1, Number(n) || 1);
  return { name: `Draft - #${num}`, slug: `draft-${num}` };
}

/**
 * @param {string} tenantId
 */
async function nextDraftNumber(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM projects
     WHERE tenant_id = $1 AND status = 'draft'`,
    [tenantId]
  );
  return (rows[0]?.n ?? 0) + 1;
}

/**
 * @param {string} tenantId
 * @param {object} session
 */
async function ensureDraftProjectForSession(tenantId, session) {
  if (session.project_id) {
    const slug =
      session.draft_project_slug ||
      (
        await query(
          `SELECT slug FROM projects WHERE id = $1 AND tenant_id = $2`,
          [session.project_id, tenantId]
        )
      ).rows[0]?.slug;
    return { projectId: session.project_id, slug };
  }

  const n = await nextDraftNumber(tenantId);
  const { name, slug } = buildDraftProjectIdentity(n);

  const { rows: inserted } = await query(
    `INSERT INTO projects (tenant_id, slug, name, scope_md, status, git_status)
     VALUES ($1, $2, $3, '', 'draft', 'not_connected')
     RETURNING id, slug`,
    [tenantId, slug, name]
  );
  const projectId = inserted[0].id;

  await query(
    `UPDATE project_discovery_sessions SET
       project_id = $3,
       expires_at = now() + interval '90 days',
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [session.id, tenantId, projectId]
  );

  return { projectId, slug: inserted[0].slug };
}

const SESSION_SELECT = `SELECT s.*, p.slug AS draft_project_slug
  FROM project_discovery_sessions s
  LEFT JOIN projects p ON p.id = s.project_id`;

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
    draftProjectSlug: row.draft_project_slug ?? null,
    hasDraftProject: Boolean(row.project_id),
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
    `${SESSION_SELECT} WHERE s.id = $1 AND s.tenant_id = $2`,
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
    `${SESSION_SELECT}
     WHERE s.id = $1 AND s.tenant_id = $2 AND s.status != 'consumed'`,
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
    `${SESSION_SELECT}
     WHERE s.id = $1 AND s.tenant_id = $2 AND s.status != 'consumed'
     FOR UPDATE OF s`,
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
  const isFirstUserMessage = countUserMessages(messages) === 0;
  if (isFirstUserMessage && !session.project_id) {
    await ensureDraftProjectForSession(tenantId, session);
    session.project_id = (
      await query(
        `SELECT project_id FROM project_discovery_sessions WHERE id = $1 AND tenant_id = $2`,
        [sessionId, tenantId]
      )
    ).rows[0]?.project_id;
  }

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
    `${SESSION_SELECT}
     WHERE s.id = $1 AND s.tenant_id = $2 AND s.status = 'ready'`,
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

  return {
    name,
    slug,
    scope,
    projectId: session.project_id || null,
    draftSlug: session.draft_project_slug || null,
  };
}

/**
 * @param {string} tenantId
 * @param {string} projectId
 * @param {{ name: string, slug: string, scope: string }} data
 */
export async function promoteDraftProject(tenantId, projectId, data) {
  const { rows } = await query(
    `SELECT slug, status FROM projects WHERE tenant_id = $1 AND id = $2`,
    [tenantId, projectId]
  );
  const current = rows[0];
  if (!current) {
    throw Object.assign(new Error("Projeto rascunho não encontrado."), {
      status: 404,
    });
  }
  if (current.status !== "draft") {
    throw Object.assign(new Error("O projeto ligado à sessão não é um rascunho."), {
      status: 409,
      code: "not_draft",
    });
  }

  const name = String(data.name ?? "").trim();
  const slug = String(data.slug ?? "").trim();
  const scope = String(data.scope ?? "").trim();
  const currentSlug = String(current.slug ?? "").trim();

  if (slug !== currentSlug) {
    const { rows: existing } = await query(
      `SELECT slug FROM projects WHERE tenant_id = $1 AND slug = $2 AND id != $3`,
      [tenantId, slug, projectId]
    );
    if (existing[0]) {
      throw Object.assign(new Error(`Projeto "${slug}" já existe.`), {
        status: 409,
      });
    }
  }

  await query(
    `UPDATE projects SET
       slug = $3,
       name = $4,
       scope_md = $5,
       status = 'active',
       updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, projectId, slug, name, scope]
  );

  return { previousSlug: currentSlug, slug };
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
  const { rows } = await query(
    `SELECT project_id FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status != 'consumed'`,
    [sessionId, tenantId]
  );
  if (!rows[0]) {
    throw Object.assign(new Error("Sessão não encontrada."), { status: 404 });
  }
  if (rows[0].project_id) {
    return;
  }
  await query(
    `DELETE FROM project_discovery_sessions
     WHERE id = $1 AND tenant_id = $2 AND status != 'consumed'`,
    [sessionId, tenantId]
  );
}
