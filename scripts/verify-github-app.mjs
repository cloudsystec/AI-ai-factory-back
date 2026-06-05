/**
 * Valida GitHub App com o mesmo fluxo do Postman:
 * JWT → GET /app/installations → POST access_tokens → GET /installation/repositories
 * Usa GITHUB_PLATFORM_INSTALLATION_ID quando definido (repos managed).
 * Uso: npm run verify:github-app
 * Teste opcional de createInOrg: GITHUB_VERIFY_CREATE_REPO=1 npm run verify:github-app
 */
import "dotenv/config";
import {
  createAppJwt,
  createRepository,
  githubAppFetch,
  getInstallationOctokit,
  loadPrivateKeyPem,
  listAppInstallations,
  getInstallationAccessToken,
  resolveInstallationAccount,
} from "../src/services/github-app-service.js";

const appId = Number(process.env.GITHUB_APP_ID || 0);
const platformInstallationId = String(
  process.env.GITHUB_PLATFORM_INSTALLATION_ID || ""
).trim();
const testInstallationId = process.env.GITHUB_TEST_INSTALLATION_ID?.trim();

if (!appId) {
  console.error("Defina GITHUB_APP_ID no .env (número na página da GitHub App).");
  process.exit(1);
}

try {
  const pem = loadPrivateKeyPem({ required: true });
  console.log("PEM carregado, appId=", appId);

  const installations = await listAppInstallations();
  console.log(
    "OK — GET /app/installations:",
    installations.length,
    "instalação(ões)"
  );
  for (const inst of installations) {
    console.log(
      "  - id=",
      inst.id,
      "account=",
      inst.account?.login || "?",
      "type=",
      inst.account?.type || "?"
    );
  }

  const installationId =
    platformInstallationId ||
    testInstallationId ||
    (installations[0]?.id != null ? String(installations[0].id) : "");
  if (!installationId) {
    console.error("Nenhuma instalação encontrada. Instale a app no GitHub primeiro.");
    process.exit(1);
  }

  if (platformInstallationId) {
    console.log("Usando GITHUB_PLATFORM_INSTALLATION_ID=", installationId);
  }

  const account = await resolveInstallationAccount(installationId);
  console.log(
    "OK — installation account:",
    account.login || "?",
    "type=",
    account.type || "?"
  );
  if (platformInstallationId && account.type !== "Organization") {
    console.warn(
      "AVISO — repos managed exigem instalação numa Organization (não User)."
    );
  }

  const { token: ghsToken, expiresAt } =
    await getInstallationAccessToken(installationId);
  console.log(
    "OK — POST /app/installations/" +
      installationId +
      "/access_tokens (expira",
    new Date(expiresAt).toISOString() +
      ")"
  );

  const reposData = await githubAppFetch("/installation/repositories", {
    token: ghsToken,
  });
  const repos = reposData.repositories || [];
  console.log(
    "OK — GET /installation/repositories:",
    reposData.total_count ?? repos.length,
    "repo(s)"
  );
  for (const r of repos.slice(0, 5)) {
    console.log("  -", r.full_name, "(default:", r.default_branch + ")");
  }

  if (repos[0]?.full_name) {
    const [owner, repo] = repos[0].full_name.split("/");
    const repoData = await githubAppFetch(`/repos/${owner}/${repo}`, {
      token: ghsToken,
    });
    console.log("OK — GET /repos/" + owner + "/" + repo + " id=", repoData.id);
  }

  if (process.env.GITHUB_VERIFY_CREATE_REPO === "1") {
    const testName = `df-verify-${Date.now().toString(36)}`;
    const created = await createRepository(installationId, {
      name: testName,
      private: true,
      description: "AI Factory verify script (apagar)",
    });
    console.log("OK — createInOrg:", created.fullName);
    const [owner, repo] = created.fullName.split("/");
    const octokit = await getInstallationOctokit(installationId);
    await octokit.repos.delete({ owner, repo });
    console.log("OK — repo de teste removido:", created.fullName);
  }

  console.log("\nTudo OK — pode Conectar GitHub no portal.");
  if (platformInstallationId && process.env.GITHUB_VERIFY_CREATE_REPO !== "1") {
    console.log(
      "Dica: GITHUB_VERIFY_CREATE_REPO=1 npm run verify:github-app — testa createInOrg."
    );
  }
} catch (e) {
  console.error("Falhou:", e.status || "", e.message || e);
  if (e.status === 401) {
    console.error(
      "\nBad credentials: confira GITHUB_APP_ID e github-app-private-key.pem (última chave gerada na app)."
    );
  }
  process.exit(1);
}
