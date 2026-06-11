import test from "node:test";
import assert from "node:assert/strict";
import { renderUserInvitedEmail } from "./user-invited.js";

test("renderUserInvitedEmail assunto e senha temporária", () => {
  const rendered = renderUserInvitedEmail({
    recipientEmail: "executor@test.com",
    temporaryPassword: "InviteTemp88",
    tenantName: "Acme",
    role: "executor",
    loginUrl: "https://app.example.com/login",
  });
  assert.equal(rendered.subject, "[DEV4LESS] - Sua conta foi criada");
  assert.match(rendered.html, /InviteTemp88/);
  assert.match(rendered.text, /InviteTemp88/);
  assert.match(rendered.html, /executor@test\.com/);
});
