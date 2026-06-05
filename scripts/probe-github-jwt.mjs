/**
 * Testa flakiness JWT GitHub: chamadas rápidas vs com pausa.
 * Uso: node scripts/probe-github-jwt.mjs
 */
import "dotenv/config";
import {
  createAppJwt,
  githubAppFetch,
  getInstallationAccessToken,
  listAppInstallations,
} from "../src/services/github-app-service.js";

const installationId = process.env.GITHUB_PLATFORM_INSTALLATION_ID || "138275451";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeJwtClaims(token) {
  const payload = token.split(".")[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json);
}

async function step(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, status: e.status, message: e.message };
  }
}

async function runOnce(label, gapMs = 0) {
  const jwt = createAppJwt();
  const claims = decodeJwtClaims(jwt);
  const skewSec = claims.iat - Math.floor(Date.now() / 1000);

  const results = [];
  results.push(
    await step("listInstallations", () => listAppInstallations())
  );
  if (gapMs) await sleep(gapMs);
  results.push(
    await step("getInstallation", () =>
      githubAppFetch(`/app/installations/${installationId}`, { token: jwt })
    )
  );
  if (gapMs) await sleep(gapMs);
  results.push(
    await step("access_tokens", () => getInstallationAccessToken(installationId))
  );

  const failed = results.filter((r) => !r.ok);
  console.log(
    label,
    gapMs ? `(gap ${gapMs}ms)` : "",
    "| iat skew(s):",
    skewSec,
    "|",
    failed.length ? "FAIL" : "OK",
    failed.map((f) => `${f.name}:${f.status}/${f.message}`).join(" ; ") || "all steps ok"
  );
}

console.log("appId=", process.env.GITHUB_APP_ID, "installation=", installationId);
console.log("--- 3 runs back-to-back ---");
for (let i = 1; i <= 3; i++) {
  await runOnce(`rapid #${i}`);
}

console.log("--- 3 runs with 1s between steps ---");
for (let i = 1; i <= 3; i++) {
  await runOnce(`gapped #${i}`, 1000);
  await sleep(3000);
}
