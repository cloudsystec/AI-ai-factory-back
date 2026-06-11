import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDiscoveryResponse,
  allDiscoveryDecisionsResolved,
  DISCOVERY_TOPIC_KEYS,
} from "./project-discovery-service.js";

function fullDecisions() {
  /** @type {Record<string, { value: string, resolved: boolean }>} */
  const d = {};
  for (const key of DISCOVERY_TOPIC_KEYS) {
    d[key] = { value: `valor-${key}`, resolved: true };
  }
  return d;
}

describe("parseDiscoveryResponse", () => {
  it("parseia resposta em discovery", () => {
    const raw = JSON.stringify({
      assistantMessage: "Qual o objetivo?",
      phase: "discovery",
      readyToCreate: false,
      decisions: { problem: { value: "", resolved: false } },
      openTopics: ["problem"],
    });
    const out = parseDiscoveryResponse(raw);
    assert.equal(out.readyToCreate, false);
    assert.equal(out.assistantMessage, "Qual o objetivo?");
  });

  it("aceita ready quando checklist completa", () => {
    const raw = JSON.stringify({
      assistantMessage: "Pronto!",
      phase: "ready",
      readyToCreate: true,
      decisions: fullDecisions(),
      openTopics: [],
      proposedName: "Meu App",
      proposedSlug: "meu-app",
      scopeMd: "## Objetivo\nApp teste",
    });
    const out = parseDiscoveryResponse(raw);
    assert.equal(out.readyToCreate, true);
    assert.equal(out.proposedSlug, "meu-app");
    assert.ok(out.scopeMd.includes("Objetivo"));
  });

  it("rebaixa ready se checklist incompleta", () => {
    const decisions = fullDecisions();
    decisions.problem.resolved = false;
    const raw = JSON.stringify({
      assistantMessage: "Pronto?",
      readyToCreate: true,
      decisions,
      proposedName: "App",
      proposedSlug: "app",
      scopeMd: "## X",
    });
    const out = parseDiscoveryResponse(raw);
    assert.equal(out.readyToCreate, false);
  });

  it("rejeita JSON inválido", () => {
    assert.throws(
      () => parseDiscoveryResponse("texto livre"),
      (err) => err.status === 502
    );
  });
});

describe("allDiscoveryDecisionsResolved", () => {
  it("exige todos os tópicos resolved com valor", () => {
    assert.equal(allDiscoveryDecisionsResolved(fullDecisions()), true);
    const partial = fullDecisions();
    partial.backend.resolved = false;
    assert.equal(allDiscoveryDecisionsResolved(partial), false);
  });
});
