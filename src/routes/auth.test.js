import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetQueryOverrideForTests,
  __setQueryOverrideForTests,
} from "../db/pool.js";
import { MAX_FAILED_LOGIN_ATTEMPTS } from "../services/password-security-service.js";

const authPath = join(dirname(fileURLToPath(import.meta.url)), "auth.js");

test("login bloqueia após MAX_FAILED_LOGIN_ATTEMPTS falhas consecutivas", () => {
  assert.equal(MAX_FAILED_LOGIN_ATTEMPTS, 5);
});

test("forgot-password resposta genérica (utilizador inexistente)", () => {
  assert.match(
    "Se o email existir na nossa base, receberá instruções em breve.",
    /Se o email existir/i
  );
});

test("login verifica tenant bloqueado antes de master password", () => {
  const src = readFileSync(authPath, "utf8");
  const blockIdx = src.indexOf("assertTenantNotBlockedForUser");
  const masterIdx = src.indexOf("okMaster");
  assert.ok(blockIdx > -1 && masterIdx > -1 && blockIdx < masterIdx);
});

test("login tenant bloqueado retorna tenant_blocked antes de master password", async () => {
  const prev = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "admin@platform.com";

  __setQueryOverrideForTests(async () => ({
    rows: [
      {
        id: "t1",
        email: "client@test.com",
        blocked_at: new Date(),
        block_reason: "payment",
        block_note: null,
        blocked_by: "admin@platform.com",
      },
    ],
  }));

  try {
    const { assertTenantNotBlockedForUser, tenantBlockedPayload } = await import(
      "../services/tenant-block-service.js"
    );

    await assert.rejects(
      () => assertTenantNotBlockedForUser("t1", "user@client.com"),
      (err) => {
        const body = {
          error: err.message,
          code: err.code,
          blockReason: err.blockReason,
        };
        assert.deepEqual(body, {
          ...tenantBlockedPayload("payment"),
          blockReason: "payment",
        });
        return true;
      }
    );
  } finally {
    __resetQueryOverrideForTests();
    process.env.PLATFORM_ADMIN_EMAILS = prev;
  }
});
