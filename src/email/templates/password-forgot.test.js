import test from "node:test";
import assert from "node:assert/strict";
import { dev4lessSubject } from "../subject.js";
import { renderPasswordForgotEmail } from "./password-forgot.js";

test("dev4lessSubject prefixa [DEV4LESS] -", () => {
  assert.equal(dev4lessSubject("Recuperação de senha"), "[DEV4LESS] - Recuperação de senha");
});

test("renderPasswordForgotEmail inclui assunto e senha temporária", () => {
  const rendered = renderPasswordForgotEmail({
    recipientEmail: "user@test.com",
    temporaryPassword: "TempPass123!",
    loginUrl: "https://app.example.com/login",
  });
  assert.equal(rendered.subject, "[DEV4LESS] - Recuperação de senha");
  assert.match(rendered.html, /TempPass123!/);
  assert.match(rendered.text, /TempPass123!/);
  assert.match(rendered.html, /obrigatório definir uma nova senha/i);
});
