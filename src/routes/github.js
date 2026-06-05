import { Router } from "express";
import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";
import {
  requireActivePlan,
  requireAuth,
  attachCapabilities,
} from "../middleware/auth.js";
import { requireCapability } from "../middleware/permissions.js";
import {
  connectInstallationToTenant,
  assertTenantGitHubConnected,
  isTenantGitHubReady,
  clearTenantGitHubConnection,
} from "../services/project-git-service.js";
import {
  getInstallUrl,
  isGitHubAppConfigured,
  isGitHubAppApiReachable,
  loadPrivateKeyPem,
  listInstallationRepos,
  listRepoBranches,
  getRepoDefaultBranch,
} from "../services/github-app-service.js";
import { log } from "../lib/logger.js";

export const githubRouter = Router();

/**
 * Callback da instalação da GitHub App (browser redirect, sem JWT).
 * Registado em /api/github/callback e /api/auth/github/callback (alias).
 */
export async function handleGitHubInstallCallback(req, res) {
  const installationId = req.query.installation_id;
  const state = req.query.state;
  const front =
    process.env.CORS_ORIGIN?.split(",")[0]?.trim() || "http://localhost:5173";

  if (!installationId || !state) {
    return res.send(`<html><body><script>window.opener?window.close():window.location="${front}/app?github=error"</script></body></html>`);
  }

  try {
    const decoded = jwt.verify(String(state), process.env.JWT_SECRET);
    const tenantId = decoded.tenantId;
    await connectInstallationToTenant(tenantId, BigInt(installationId));
    return res.send(`<html><body><p>Conectado! Esta janela vai fechar.</p><script>window.opener?window.close():window.location="${front}/app?github=connected"</script></body></html>`);
  } catch (e) {
    const msg = String(e.message || e);
    log.warn("GitHub callback falhou", { reason: msg });
    return res.send(`<html><body><p>Erro na conexão.</p><script>window.opener?window.close():window.location="${front}/app?github=error"</script></body></html>`);
  }
}

githubRouter.get("/callback", handleGitHubInstallCallback);

githubRouter.use(requireAuth, attachCapabilities, requireActivePlan);

githubRouter.get("/status", async (req, res) => {
  const { rows } = await query(
    `SELECT github_installation_id, github_account_login, github_connected_at
     FROM tenants WHERE id = $1`,
    [req.user.tenantId]
  );
  const t = rows[0];
  const hasInstallation = Boolean(t?.github_installation_id);
  const envConfigured = isGitHubAppConfigured();
  const apiConfigured = envConfigured ? await isGitHubAppApiReachable() : false;
  let ready = false;
  if (hasInstallation && apiConfigured) {
    ready = await isTenantGitHubReady(req.user.tenantId);
    if (!ready) {
      await clearTenantGitHubConnection(req.user.tenantId);
    }
  }
  res.json({
    configured: apiConfigured,
    connected: ready,
    installationId: ready ? Number(t?.github_installation_id) : null,
    accountLogin: ready ? t?.github_account_login || null : null,
    connectedAt: ready ? t?.github_connected_at || null : null,
  });
});

githubRouter.get("/install", requireCapability("write"), (req, res) => {
  try {
    if (!isGitHubAppConfigured()) {
      let detail =
        "GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_PATH ou GITHUB_APP_PRIVATE_KEY";
      try {
        loadPrivateKeyPem({ required: true });
      } catch (e) {
        detail = e.message || detail;
      }
      return res.status(503).json({
        error: "GitHub App não configurada no servidor",
        detail,
      });
    }
    const state = jwt.sign(
      { tenantId: req.user.tenantId, uid: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );
    return res.json({ url: getInstallUrl(state) });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || String(e) });
  }
});

githubRouter.get("/repos", requireCapability("write"), async (req, res) => {
  try {
    const instId = req.query.installationId
      ? Number(req.query.installationId)
      : await assertTenantGitHubConnected(req.user.tenantId);
    const repos = await listInstallationRepos(instId);
    res.json(repos);
  } catch (e) {
    res.status(e.status || 500).json({
      error: e.message || String(e),
      code: e.code || undefined,
    });
  }
});

githubRouter.get(
  "/repos/:owner/:repo/branches",
  requireCapability("write"),
  async (req, res) => {
    const instId = req.query.installationId
      ? Number(req.query.installationId)
      : await assertTenantGitHubConnected(req.user.tenantId);
    const branches = await listRepoBranches(
      instId,
      req.params.owner,
      req.params.repo
    );
    const repoDefault = await getRepoDefaultBranch(
      instId,
      req.params.owner,
      req.params.repo
    );
    res.json({ branches, defaultBranch: repoDefault });
  }
);
