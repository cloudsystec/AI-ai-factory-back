import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseMacroHelpResponse,
  isTenantAdminKeyConfigured,
  getMacroHelpStatus,
} from "./macro-help-service.js";

describe("parseMacroHelpResponse", () => {
  it("parseia JSON direto", () => {
    const raw = JSON.stringify({
      scopeMd: "## Objetivo\nApp de barbearia",
      assistantMessage: "Adicionei objetivo e funcionalidades.",
    });
    const out = parseMacroHelpResponse(raw);
    assert.equal(out.scopeMd.includes("barbearia"), true);
    assert.equal(out.assistantMessage.includes("Adicionei"), true);
  });

  it("parseia JSON dentro de fence markdown", () => {
    const raw =
      '```json\n{"scopeMd":"# Escopo","assistantMessage":"Ok"}\n```';
    const out = parseMacroHelpResponse(raw);
    assert.equal(out.scopeMd, "# Escopo");
    assert.equal(out.assistantMessage, "Ok");
  });

  it("rejeita resposta inválida", () => {
    assert.throws(
      () => parseMacroHelpResponse("texto livre sem json"),
      (err) => err.status === 502
    );
  });

  it("rejeita scopeMd vazio", () => {
    assert.throws(
      () =>
        parseMacroHelpResponse(
          JSON.stringify({ scopeMd: "  ", assistantMessage: "x" })
        ),
      (err) => err.status === 502
    );
  });
});

describe("macro-help readiness exports", () => {
  it("exporta funções de readiness", () => {
    assert.equal(typeof isTenantAdminKeyConfigured, "function");
    assert.equal(typeof getMacroHelpStatus, "function");
  });
});
