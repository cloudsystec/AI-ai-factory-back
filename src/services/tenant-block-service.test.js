import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetQueryOverrideForTests,
  __setQueryOverrideForTests,
} from "../db/pool.js";

const servicePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "tenant-block-service.js"
);

test("isTenantBlocked", async () => {
  const { isTenantBlocked } = await import("./tenant-block-service.js");
  assert.equal(isTenantBlocked({ blocked_at: null }), false);
  assert.equal(isTenantBlocked({ blocked_at: "2024-01-01" }), true);
  assert.equal(isTenantBlocked(null), false);
});

test("tenantBlockedMessage por motivo", async () => {
  const { tenantBlockedMessage } = await import("./tenant-block-service.js");
  assert.match(tenantBlockedMessage("payment"), /pagamento/i);
  assert.match(tenantBlockedMessage("security"), /segurança/i);
  assert.match(tenantBlockedMessage("other"), /Empresa bloqueada/i);
  assert.match(tenantBlockedMessage(null), /Empresa bloqueada/i);
});

test("tenantBlockedPayload", async () => {
  const { tenantBlockedPayload } = await import("./tenant-block-service.js");
  const payload = tenantBlockedPayload("payment");
  assert.equal(payload.code, "tenant_blocked");
  assert.match(payload.error, /pagamento/i);
  assert.equal(payload.blockReason, "payment");
});

test("BLOCK_REASONS contém valores esperados", async () => {
  const { BLOCK_REASONS } = await import("./tenant-block-service.js");
  assert.equal(BLOCK_REASONS.has("security"), true);
  assert.equal(BLOCK_REASONS.has("payment"), true);
  assert.equal(BLOCK_REASONS.has("other"), true);
});

test("assertTenantNotBlockedForUser ignora platform admin", async () => {
  const prev = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "admin@platform.com";
  try {
    const { assertTenantNotBlockedForUser } = await import("./tenant-block-service.js");
    await assertTenantNotBlockedForUser("t1", "admin@platform.com");
  } finally {
    process.env.PLATFORM_ADMIN_EMAILS = prev;
  }
});

test("assertTenantNotBlockedForUser rejeita tenant bloqueado (inclui master password path)", async () => {
  const prev = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "admin@platform.com";

  __setQueryOverrideForTests(async () => ({
    rows: [
      {
        id: "t1",
        email: "client@test.com",
        blocked_at: new Date(),
        block_reason: "security",
        block_note: null,
        blocked_by: "admin@platform.com",
      },
    ],
  }));

  try {
    const { assertTenantNotBlockedForUser } = await import("./tenant-block-service.js");
    await assert.rejects(
      () => assertTenantNotBlockedForUser("t1", "user@client.com"),
      (err) => {
        assert.equal(err.code, "tenant_blocked");
        assert.equal(err.status, 403);
        assert.match(err.message, /segurança/i);
        return true;
      }
    );
  } finally {
    __resetQueryOverrideForTests();
    process.env.PLATFORM_ADMIN_EMAILS = prev;
  }
});

test("blockTenant rejeita motivo inválido", async () => {
  const { blockTenant } = await import("./tenant-block-service.js");
  await assert.rejects(
    () => blockTenant("t1", { reason: "invalid", blockedBy: "admin@platform.com" }),
    (err) => err.status === 400
  );
});

test("blockTenant atualiza campos e pausa projetos", async () => {
  const prevAdmin = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "admin@platform.com";

  let updateParams = null;
  let pauseCalls = 0;

  __setQueryOverrideForTests(async (sql, params) => {
    if (sql.includes("FROM tenants WHERE id")) {
      return {
        rows: [
          {
            id: "t1",
            email: "client@test.com",
            blocked_at: null,
            block_reason: null,
            block_note: null,
            blocked_by: null,
          },
        ],
      };
    }
    if (sql.includes("UPDATE tenants SET")) {
      updateParams = params;
      return {
        rows: [
          {
            blocked_at: new Date("2026-06-10T12:00:00Z"),
            block_reason: "payment",
            block_note: "nota teste",
            blocked_by: "admin@platform.com",
          },
        ],
      };
    }
    if (sql.includes("SELECT slug FROM projects")) {
      return { rows: [{ slug: "proj-a" }, { slug: "proj-b" }] };
    }
    if (sql.includes("INSERT INTO tenant_execution")) {
      pauseCalls += 1;
      return { rows: [] };
    }
    return { rows: [] };
  });

  try {
    const { blockTenant } = await import("./tenant-block-service.js");
    const result = await blockTenant("t1", {
      reason: "payment",
      note: "nota teste",
      blockedBy: "admin@platform.com",
    });

    assert.equal(result.blocked, true);
    assert.equal(result.blockReason, "payment");
    assert.equal(result.pausedProjects, 2);
    assert.deepEqual(updateParams, [
      "t1",
      "payment",
      "nota teste",
      "admin@platform.com",
    ]);
    assert.equal(pauseCalls, 2);
  } finally {
    __resetQueryOverrideForTests();
    process.env.PLATFORM_ADMIN_EMAILS = prevAdmin;
  }
});

test("unblockTenant limpa campos de bloqueio", async () => {
  let cleared = false;

  __setQueryOverrideForTests(async (sql) => {
    if (sql.includes("FROM tenants WHERE id")) {
      return {
        rows: [
          {
            id: "t1",
            email: "client@test.com",
            blocked_at: new Date(),
            block_reason: "payment",
            block_note: "x",
            blocked_by: "admin@platform.com",
          },
        ],
      };
    }
    if (sql.includes("blocked_at = NULL")) {
      cleared = true;
      return { rows: [] };
    }
    return { rows: [] };
  });

  try {
    const { unblockTenant } = await import("./tenant-block-service.js");
    const result = await unblockTenant("t1", { unblockedBy: "admin@platform.com" });
    assert.equal(result.blocked, false);
    assert.equal(cleared, true);
  } finally {
    __resetQueryOverrideForTests();
  }
});

test("blockTenant persiste campos de bloqueio no SQL", () => {
  const src = readFileSync(servicePath, "utf8");
  assert.match(src, /blocked_at = now\(\)/);
  assert.match(src, /block_reason = \$2/);
  assert.match(src, /block_note = \$3/);
  assert.match(src, /blocked_by = \$4/);
});

test("unblockTenant limpa campos no SQL", () => {
  const src = readFileSync(servicePath, "utf8");
  assert.match(src, /blocked_at = NULL/);
  assert.match(src, /block_reason = NULL/);
  assert.match(src, /block_note = NULL/);
  assert.match(src, /blocked_by = NULL/);
});
