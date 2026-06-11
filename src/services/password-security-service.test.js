import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../lib/password.js";
import {
  MAX_FAILED_LOGIN_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  assertPasswordStrength,
  assertUserCanAuthenticate,
  changeOwnPassword,
  generateTemporaryPassword,
  isUserLocked,
} from "./password-security-service.js";

test("generateTemporaryPassword usa STRIPE_DEFAULT_USER_PASSWORD em dev", () => {
  const prev = process.env.STRIPE_DEFAULT_USER_PASSWORD;
  process.env.STRIPE_DEFAULT_USER_PASSWORD = "dev-temp-123";
  try {
    assert.equal(generateTemporaryPassword(), "dev-temp-123");
  } finally {
    if (prev === undefined) delete process.env.STRIPE_DEFAULT_USER_PASSWORD;
    else process.env.STRIPE_DEFAULT_USER_PASSWORD = prev;
  }
});

test("generateTemporaryPassword gera string não vazia sem env", () => {
  const prev = process.env.STRIPE_DEFAULT_USER_PASSWORD;
  delete process.env.STRIPE_DEFAULT_USER_PASSWORD;
  try {
    const pwd = generateTemporaryPassword();
    assert.ok(typeof pwd === "string" && pwd.length >= 8);
  } finally {
    if (prev === undefined) delete process.env.STRIPE_DEFAULT_USER_PASSWORD;
    else process.env.STRIPE_DEFAULT_USER_PASSWORD = prev;
  }
});

test("assertPasswordStrength exige mínimo de caracteres", () => {
  assert.throws(() => assertPasswordStrength("abc"), /mín\. 8/);
  assert.doesNotThrow(() => assertPasswordStrength("abcdefgh"));
});

test("isUserLocked e assertUserCanAuthenticate", () => {
  assert.equal(isUserLocked({ locked_at: null }), false);
  assert.equal(isUserLocked({ locked_at: new Date() }), true);
  assert.doesNotThrow(() => assertUserCanAuthenticate({ locked_at: null }));
  assert.throws(() => assertUserCanAuthenticate({ locked_at: new Date() }), /bloqueada/);
});

test("changeOwnPassword valida senha atual e força", async () => {
  const current = "temp-pass-1";
  const hash = hashPassword(current);
  const user = { password_hash: hash, password_must_change: true };

  await assert.rejects(
    () =>
      changeOwnPassword("u1", { currentPassword: "wrong", newPassword: "newpass12" }, user),
    /atual incorreta/
  );

  await assert.rejects(
    () =>
      changeOwnPassword(
        "u1",
        { currentPassword: current, newPassword: "short" },
        user
      ),
    /mín\. 8/
  );

  await assert.rejects(
    () =>
      changeOwnPassword(
        "u1",
        {
          currentPassword: current,
          newPassword: "newpass12",
          confirmNewPassword: "otherpass12",
        },
        user
      ),
    /Confirmação/
  );
});

test("MAX_FAILED_LOGIN_ATTEMPTS é 5", () => {
  assert.equal(MAX_FAILED_LOGIN_ATTEMPTS, 5);
  assert.equal(MIN_PASSWORD_LENGTH, 8);
});
