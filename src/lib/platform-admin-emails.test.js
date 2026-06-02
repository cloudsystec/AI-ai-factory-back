import test from "node:test";
import assert from "node:assert/strict";

test("isPlatformAdminEmail", async () => {
  const prev = process.env.PLATFORM_ADMIN_EMAILS;
  process.env.PLATFORM_ADMIN_EMAILS = "Admin@Test.com, other@x.com";
  const { isPlatformAdminEmail, getPlatformAdminEmails, sqlExcludePlatformAdminEmails } = await import(
    "./platform-admin-emails.js"
  );
  assert.deepEqual(getPlatformAdminEmails(), ["admin@test.com", "other@x.com"]);
  assert.equal(isPlatformAdminEmail("admin@test.com"), true);
  assert.equal(isPlatformAdminEmail("Admin@Test.com"), true);
  assert.equal(isPlatformAdminEmail("user@test.com"), false);
  const frag = sqlExcludePlatformAdminEmails("u.email", 2);
  assert.match(frag.sql, /\$2/);
  assert.doesNotMatch(frag.sql, /\$1[^0-9]/);
  process.env.PLATFORM_ADMIN_EMAILS = prev;
});
