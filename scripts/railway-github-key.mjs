/**
 * Gera valor GITHUB_APP_PRIVATE_KEY para colar no Railway (uma linha com \n).
 * Valida JWT localmente antes de imprimir.
 *
 * Uso:
 *   node scripts/railway-github-key.mjs
 *   node scripts/railway-github-key.mjs path/to/key.pem
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import {
  createAppJwt,
  loadPrivateKeyPem,
  listAppInstallations,
} from "../src/services/github-app-service.js";

const pemPath = process.argv[2]?.trim();
if (pemPath) {
  process.env.GITHUB_APP_PRIVATE_KEY = readFileSync(pemPath, "utf8");
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
}

const pem = loadPrivateKeyPem({ required: true });
const fingerprint = createHash("sha256").update(pem).digest("hex").slice(0, 16);
const appId = process.env.GITHUB_APP_ID;
const slug = process.env.GITHUB_APP_SLUG;
const platformId = process.env.GITHUB_PLATFORM_INSTALLATION_ID;

const railwayValue = pem.trim().replace(/\n/g, "\\n");

console.log("=== GitHub App — Railway ===");
console.log("GITHUB_APP_ID=", appId);
console.log("GITHUB_APP_SLUG=", slug);
console.log("GITHUB_PLATFORM_INSTALLATION_ID=", platformId);
console.log("pemFingerprint=", fingerprint);
console.log("pemLines=", pem.split("\n").filter(Boolean).length);

try {
  const token = createAppJwt();
  jwt.verify(token, pem, { algorithms: ["RS256"] });
  console.log("jwtSelfVerify=OK");
} catch (e) {
  console.error("jwtSelfVerify=FAIL", e.message);
  process.exit(1);
}

try {
  const n = (await listAppInstallations()).length;
  console.log("githubApiTest=OK installations=", n);
} catch (e) {
  console.error("githubApiTest=FAIL", e.status, e.message);
  process.exit(1);
}

console.log("\n--- Cole no Railway (GITHUB_APP_PRIVATE_KEY) ---");
console.log("REMOVER GITHUB_APP_PRIVATE_KEY_PATH se existir.\n");
console.log(railwayValue);
console.log("\n--- Teste após deploy ---");
console.log("GET https://<back>/health/github  →  { ok: true, pemFingerprint:", fingerprint, "}");
