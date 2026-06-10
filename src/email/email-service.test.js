import test from "node:test";
import assert from "node:assert/strict";
import {
  loadEmailConfig,
  resolveEmailProviderName,
  isEmailConfigured,
  createEmailProvider,
} from "./email-config.js";
import {
  sendEmail,
  resetEmailProviderForTests,
} from "./email-service.js";

function withEnv(overrides, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    resetEmailProviderForTests();
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("resolveEmailProviderName usa noop quando explícito", async () => {
  await withEnv(
    { EMAIL_PROVIDER: "noop", EMAIL_FROM: "noreply@test.com" },
    async () => {
      assert.equal(resolveEmailProviderName(), "noop");
      const provider = await createEmailProvider();
      const result = await provider.send({
        to: "a@test.com",
        subject: "Teste",
        text: "Olá",
      });
      assert.equal(result.messageId, "noop-message-id");
    }
  );
});

test("sendEmail valida campos obrigatórios", async () => {
  await withEnv({ EMAIL_PROVIDER: "noop", EMAIL_FROM: "noreply@test.com" }, async () => {
    await assert.rejects(
      () => sendEmail({ to: "", subject: "x", text: "y" }),
      /Destinatário/
    );
    await assert.rejects(
      () => sendEmail({ to: "a@test.com", subject: "", text: "y" }),
      /Assunto/
    );
    await assert.rejects(
      () => sendEmail({ to: "a@test.com", subject: "x" }),
      /Corpo do e-mail/
    );
  });
});

test("sendEmail envia com provider noop", async () => {
  await withEnv({ EMAIL_PROVIDER: "noop", EMAIL_FROM: "noreply@test.com" }, async () => {
    const result = await sendEmail({
      to: [" One@test.com ", "two@test.com"],
      subject: "Assunto",
      text: "Corpo",
      html: "<p>Corpo</p>",
    });
    assert.equal(result.messageId, "noop-message-id");
  });
});

test("loadEmailConfig e isEmailConfigured", async () => {
  await withEnv(
    {
      EMAIL_PROVIDER: "console",
      EMAIL_FROM: "noreply@test.com",
      EMAIL_FROM_NAME: "dev for less",
      PUBLIC_FRONT_URL: "https://www.devforless.com.br",
    },
    async () => {
      const cfg = loadEmailConfig();
      assert.equal(cfg.provider, "console");
      assert.equal(cfg.from, "noreply@test.com");
      assert.equal(cfg.publicFrontUrl, "https://www.devforless.com.br");
      assert.equal(isEmailConfigured(), true);
    }
  );
});

test("createEmailProvider falha SES sem credenciais", async () => {
  await withEnv(
    {
      EMAIL_PROVIDER: "ses",
      EMAIL_FROM: "noreply@test.com",
      AWS_REGION: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
    },
    async () => {
      await assert.rejects(() => createEmailProvider(), /AWS SES não configurado/);
    }
  );
});

test("createEmailProvider falha Postmark sem token", async () => {
  await withEnv(
    {
      EMAIL_PROVIDER: "postmark",
      EMAIL_FROM: "noreply@test.com",
      POSTMARK_SERVER_TOKEN: "",
      POSTMARK_API_TOKEN: "",
    },
    async () => {
      await assert.rejects(() => createEmailProvider(), /Postmark não configurado/);
    }
  );
});

test("resolveEmailProviderName e isEmailConfigured com postmark", async () => {
  await withEnv(
    {
      EMAIL_PROVIDER: "postmark",
      EMAIL_FROM: "noreply@test.com",
      POSTMARK_SERVER_TOKEN: "pm-test-token",
    },
    async () => {
      assert.equal(resolveEmailProviderName(), "postmark");
      assert.equal(isEmailConfigured(), true);
      const cfg = loadEmailConfig();
      assert.equal(cfg.postmarkMessageStream, "outbound");
    }
  );
});
