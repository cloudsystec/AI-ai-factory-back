/**
 * Valida GitHub App com o mesmo fluxo do Postman:
 * JWT → GET /app/installations → POST access_tokens → GET /installation/repositories
 * Uso: npm run verify:github-app
 */
import "dotenv/config";
import {
  createAppJwt,
  githubAppFetch,
  loadPrivateKeyPem,
  listAppInstallations,
  getInstallationAccessToken,
} from "../src/services/github-app-service.js";

const appId = Number(process.env.GITHUB_APP_ID || 0);
const testInstallationId = process.env.GITHUB_TEST_INSTALLATION_ID?.trim();

if (!appId) {
  console.error("Defina GITHUB_APP_ID no .env (número na página da GitHub App).");
  process.exit(1);
}

try {
  const pem = loadPrivateKeyPem({ required: true });
  console.log("PEM carregado, appId=", appId);

  const appJwt = createAppJwt();
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
      inst.account?.login || "?"
    );
  }

  const installationId =
    testInstallationId ||
    (installations[0]?.id != null ? String(installations[0].id) : "");
  if (!installationId) {
    console.error("Nenhuma instalação encontrada. Instale a app no GitHub primeiro.");
    process.exit(1);
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

  console.log("\nTudo OK — pode Conectar GitHub no portal.");
} catch (e) {
  console.error("Falhou:", e.status || "", e.message || e);
  if (e.status === 401) {
    console.error(
      "\nBad credentials: confira GITHUB_APP_ID e github-app-private-key.pem (última chave gerada na app)."
    );
  }
  process.exit(1);
}
