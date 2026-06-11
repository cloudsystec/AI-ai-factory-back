import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../html-utils.js";
import {
  deriveRecipientName,
  renderWelcomeEmail,
} from "./welcome.js";

test("escapeHtml previne XSS", () => {
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("deriveRecipientName a partir do email", () => {
  assert.equal(deriveRecipientName("daniel.espindola@test.com"), "Daniel Espindola");
  assert.equal(deriveRecipientName(""), "Usuário");
});

test("renderWelcomeEmail usa /login com email por defeito", () => {
  const prev = process.env.PUBLIC_FRONT_URL;
  process.env.PUBLIC_FRONT_URL = "https://app.example.com";
  try {
    const rendered = renderWelcomeEmail({
      recipientEmail: "user@test.com",
      recipientName: "Ana",
    });
    assert.match(
      rendered.html,
      /https:\/\/app\.example\.com\/login\?email=user%40test\.com/
    );
    assert.match(rendered.text, /https:\/\/app\.example\.com\/login\?email=user%40test\.com/);
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_FRONT_URL;
    else process.env.PUBLIC_FRONT_URL = prev;
  }
});

test("renderWelcomeEmail inclui tagline, login e nome escapado", () => {
  const rendered = renderWelcomeEmail({
    recipientEmail: "user@test.com",
    recipientName: "<script>alert(1)</script>",
    loginUrl: "https://app.example.com/login",
  });

  assert.match(rendered.subject, /^\[DEV4LESS\] - /);
  assert.match(rendered.html, /IA QUE ENTREGA\. DO BACKLOG AO DEPLOY\./);
  assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<script>alert/);
  assert.match(rendered.html, /https:\/\/app\.example\.com\/login/);
  assert.match(rendered.text, /https:\/\/app\.example\.com\/login/);
  assert.match(rendered.text, /user@test\.com/);
});

test("renderWelcomeEmail inclui senha temporária quando fornecida", () => {
  const rendered = renderWelcomeEmail({
    recipientEmail: "user@test.com",
    recipientName: "Ana",
    temporaryPassword: "WelcomeTemp77",
  });
  assert.match(rendered.subject, /\[DEV4LESS\] - Bem-vindo/);
  assert.match(rendered.html, /WelcomeTemp77/);
  assert.match(rendered.text, /WelcomeTemp77/);
  assert.match(rendered.html, /obrigatório definir uma nova senha/i);
});

test("renderWelcomeEmail omite badge de plano quando planId ausente", () => {
  const rendered = renderWelcomeEmail({
    recipientEmail: "user@test.com",
    recipientName: "Ana",
  });
  assert.doesNotMatch(rendered.html, /Plano Starter/);
  assert.doesNotMatch(rendered.html, /Plano Team/);
});

test("renderWelcomeEmail inclui badges de plano e empresa", () => {
  const rendered = renderWelcomeEmail({
    recipientEmail: "user@test.com",
    recipientName: "Ana",
    planId: "starter",
    companyName: "Acme Lda",
  });
  assert.match(rendered.html, /Plano Starter/);
  assert.match(rendered.html, /Acme Lda/);
  assert.match(rendered.text, /Plano Starter/);
  assert.match(rendered.text, /Empresa: Acme Lda/);
});
