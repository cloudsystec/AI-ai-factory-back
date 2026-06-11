import test from "node:test";
import assert from "node:assert/strict";
import { classifySensitiveIntent } from "./project-copilot-guard.js";
import { parseCopilotResponse } from "./project-copilot-service.js";

test("classifySensitiveIntent detecta SQL", () => {
  assert.ok(classifySensitiveIntent("execute select * from tenants"));
});

test("classifySensitiveIntent ignora mensagem normal", () => {
  assert.equal(classifySensitiveIntent("qual o custo do projeto?"), null);
});

test("parseCopilotResponse parseia JSON", () => {
  const out = parseCopilotResponse(
    JSON.stringify({
      assistantMessage: "Olá",
      toolCalls: [{ name: "get_project_cost", args: {} }],
      pendingActions: [],
    })
  );
  assert.equal(out.assistantMessage, "Olá");
  assert.equal(out.toolCalls.length, 1);
});
