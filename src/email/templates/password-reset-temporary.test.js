import test from "node:test";
import assert from "node:assert/strict";
import { renderPasswordResetTemporaryEmail } from "./password-reset-temporary.js";

test("renderPasswordResetTemporaryEmail assunto e senha temp", () => {
  const rendered = renderPasswordResetTemporaryEmail({
    recipientEmail: "user@test.com",
    temporaryPassword: "ResetTemp99",
    loginUrl: "https://app.example.com/login",
  });
  assert.equal(rendered.subject, "[DEV4LESS] - Nova senha temporária");
  assert.match(rendered.html, /ResetTemp99/);
  assert.match(rendered.text, /ResetTemp99/);
  assert.match(rendered.html, /Nova senha temporária/);
});
