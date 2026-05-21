import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password.js";

describe("password", () => {
  it("hash e verify", () => {
    const h = hashPassword("secret123");
    assert.ok(h.startsWith("scrypt:"));
    assert.equal(verifyPassword("secret123", h), true);
    assert.equal(verifyPassword("wrong", h), false);
  });
});
