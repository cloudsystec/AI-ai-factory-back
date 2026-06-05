import { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";

const GITHUB_API_BASE = "https://api.github.com";

const BACK_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** @type {Map<string, { token: string, expiresAt: number }>} */
const tokenCache = new Map();

function appId() {
  const id = process.env.GITHUB_APP_ID || "";
  return id ? Number(id) : 0;
}

function clientId() {
  return process.env.GITHUB_APP_CLIENT_ID || "Iv23li37JucJf0fD9Osg";
}

function appSlug() {
  return process.env.GITHUB_APP_SLUG || "";
}

/**
 * @param {string} configured
 */
function resolvePrivateKeyPath(configured) {
  const trimmed = String(configured || "").trim();
  if (!trimmed) return "";
  return path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(BACK_ROOT, trimmed);
}

/**
 * @param {{ required?: boolean }} [opts]
 */
export function loadPrivateKeyPem(opts = {}) {
  const inline = String(process.env.GITHUB_APP_PRIVATE_KEY || "").trim();
  if (inline) {
    const decoded = inline.includes("\\n")
      ? inline.replace(/\\n/g, "\n")
      : inline;
    return normalizePrivateKeyPem(decoded);
  }

  const configured = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!configured) {
    if (opts.required) {
      throw githubKeyError(
        "Defina GITHUB_APP_PRIVATE_KEY_PATH ou GITHUB_APP_PRIVATE_KEY no .env do ai-factory-back."
      );
    }
    return "";
  }

  const absPath = resolvePrivateKeyPath(configured);
  if (!existsSync(absPath)) {
    throw githubKeyError(
      `Ficheiro não encontrado: ${absPath}. No GitHub: Settings → Developer settings → GitHub Apps → ${appSlug() || "sua app"} → Private keys → Generate a private key. Guarde o .pem em ai-factory-back/github-app-private-key.pem (ou ajuste GITHUB_APP_PRIVATE_KEY_PATH).`
    );
  }

  return normalizePrivateKeyPem(readFileSync(absPath, "utf8"));
}

/**
 * @param {string} raw
 */
function normalizePrivateKeyPem(raw) {
  const pem = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) {
    throw githubKeyError("PEM inválido: ficheiro deve conter BEGIN/END PRIVATE KEY.");
  }
  return `${pem}\n`;
}

/**
 * @param {string} message
 */
function githubKeyError(message) {
  return Object.assign(new Error(message), {
    status: 503,
    code: "github_key_missing",
  });
}

function privateKeyPem() {
  return loadPrivateKeyPem({ required: true });
}

export function isGitHubAppConfigured() {
  try {
    return Boolean(loadPrivateKeyPem() && appId() && appSlug());
  } catch (e) {
    if (e?.code === "github_key_missing") return false;
    throw e;
  }
}

/**
 * @param {string} pem
 */
function pemFingerprint(pem) {
  return createHash("sha256").update(pem).digest("hex").slice(0, 16);
}

function githubApiHeaders(bearerToken) {
  return {
    Authorization: `Bearer ${bearerToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ai-factory-back",
  };
}

/**
 * JWT de app (mesmo algoritmo do test-github-app.js: iat -60s, exp +9min).
 */
export function createAppJwt() {
  const pem = privateKeyPem();
  const id = appId();
  if (!id) {
    throw Object.assign(new Error("GITHUB_APP_ID não configurado"), {
      status: 503,
      code: "github_not_configured",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60;
  // exp relativo a iat (8 min) — evita 401 se o relógio local estiver adiantado vs GitHub
  const exp = iat + 8 * 60;
  return jwt.sign({ iat, exp, iss: String(id) }, pem, { algorithm: "RS256" });
}

/**
 * @param {string} apiPath path ou URL completa
 * @param {{ method?: string, token: string, body?: unknown }} options
 */
export async function githubAppFetch(apiPath, options) {
  const { method = "GET", token, body } = options;
  const url = apiPath.startsWith("http")
    ? apiPath
    : `${GITHUB_API_BASE}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const res = await fetch(url, {
    method,
    headers: githubApiHeaders(token),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(
      new Error(data.message || `GitHub API ${res.status}`),
      { status: res.status, response: data }
    );
    throw err;
  }
  return data;
}

/** @returns {Promise<unknown[]>} */
export async function listAppInstallations() {
  const appJwt = createAppJwt();
  const data = await githubAppFetch("/app/installations", { token: appJwt });
  return Array.isArray(data) ? data : [];
}

/**
 * Valida credenciais com GET /app/installations (fluxo Postman).
 */
export async function isGitHubAppApiReachable() {
  if (!isGitHubAppConfigured()) return false;
  try {
    await listAppInstallations();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {bigint|number|string} installationId
 */
export async function getInstallationAccessToken(installationId) {
  const appJwt = createAppJwt();
  try {
    const data = await githubAppFetch(
      `/app/installations/${Number(installationId)}/access_tokens`,
      { method: "POST", token: appJwt }
    );
    return {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };
  } catch (e) {
    const pem = privateKeyPem();
    const { log } = await import("../lib/logger.js");
    log.warn("GitHub access_tokens falhou", {
      appId: appId(),
      installationId: String(installationId),
      pemFingerprint: pemFingerprint(pem),
      status: e.status,
      message: e.message,
    });
    throw e;
  }
}

/**
 * @param {bigint|number|string} installationId
 */
export async function getInstallationOctokit(installationId) {
  const id = String(installationId);
  const cached = tokenCache.get(id);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return new Octokit({ auth: cached.token });
  }
  const { token, expiresAt } = await getInstallationAccessToken(installationId);
  tokenCache.set(id, { token, expiresAt });
  return new Octokit({ auth: token });
}

export function getInstallUrl(state) {
  const slug = appSlug();
  if (!slug) {
    throw Object.assign(new Error("GITHUB_APP_SLUG não configurado"), {
      status: 503,
    });
  }
  const base = `https://github.com/apps/${slug}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/**
 * @param {bigint|number} installationId
 */
export async function listInstallationRepos(installationId) {
  const octokit = await getInstallationOctokit(installationId);
  const repos = [];
  let page = 1;
  for (;;) {
    const { data } = await octokit.apps.listReposAccessibleToInstallation({
      per_page: 100,
      page,
    });
    for (const r of data.repositories || []) {
      repos.push({
        fullName: r.full_name,
        name: r.name,
        private: r.private,
        defaultBranch: r.default_branch,
      });
    }
    if ((data.repositories || []).length < 100) break;
    page += 1;
  }
  return repos;
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 */
export async function listRepoBranches(installationId, owner, repo) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.listBranches({
    owner,
    repo,
    per_page: 100,
  });
  return data.map((b) => b.name);
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 */
export async function getRepoDefaultBranch(installationId, owner, repo) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch || "main";
}

/**
 * @param {{ full_name?: string, default_branch?: string }} data
 */
function mapRepositoryResult(data) {
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch || "main",
  };
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 */
export async function getRepository(installationId, owner, repo) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.repos.get({ owner, repo });
  return mapRepositoryResult(data);
}

/**
 * @param {bigint|number} installationId
 * @param {{ name: string, private?: boolean, description?: string }} opts
 */
export async function createRepository(installationId, opts) {
  const octokit = await getInstallationOctokit(installationId);
  const account = await resolveInstallationAccount(installationId);
  if (!account.login) {
    throw Object.assign(new Error("Installation sem account login."), {
      status: 503,
      code: "github_installation_invalid",
    });
  }
  if (account.type !== "Organization") {
    throw Object.assign(
      new Error(
        "Criação de repositório via GitHub App requer instalação numa organização."
      ),
      { status: 422, code: "github_org_required_for_create" }
    );
  }

  const payload = {
    org: account.login,
    name: opts.name,
    private: opts.private !== false,
    description: opts.description || "AI Factory project",
    auto_init: true,
  };

  try {
    const { data } = await octokit.repos.createInOrg(payload);
    return mapRepositoryResult(data);
  } catch (e) {
    if (e.status !== 422) throw e;
    try {
      return await getRepository(installationId, account.login, opts.name);
    } catch (getErr) {
      if (getErr.status === 404) throw e;
      throw getErr;
    }
  }
}

/**
 * @param {bigint|number} installationId
 * @returns {Promise<{ login: string, type: string }>}
 */
export async function resolveInstallationAccount(installationId) {
  const appJwt = createAppJwt();
  const data = await githubAppFetch(
    `/app/installations/${Number(installationId)}`,
    { token: appJwt }
  );
  return {
    login: data.account?.login || "",
    type: data.account?.type || "",
  };
}

/**
 * @param {bigint|number} installationId
 */
export async function resolveInstallationAccountLogin(installationId) {
  const account = await resolveInstallationAccount(installationId);
  return account.login;
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 * @param {{ title: string, body: string, head: string, base: string }} pr
 */
export async function createPullRequest(installationId, owner, repo, pr) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title: pr.title,
    body: pr.body,
    head: pr.head,
    base: pr.base,
  });
  return { number: data.number, url: data.html_url, mergeable: data.mergeable };
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 */
export async function getPullRequest(installationId, owner, repo, pullNumber) {
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  return data;
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 */
export async function mergePullRequest(installationId, owner, repo, pullNumber) {
  const octokit = await getInstallationOctokit(installationId);
  const method =
    process.env.GITHUB_TL_MERGE_METHOD === "merge"
      ? "merge"
      : process.env.GITHUB_TL_MERGE_METHOD === "rebase"
        ? "rebase"
        : "squash";
  const { data } = await octokit.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: method,
  });
  return data;
}

/**
 * @param {bigint|number} installationId
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullNumber
 * @param {string} body
 */
export async function commentOnPullRequest(
  installationId,
  owner,
  repo,
  pullNumber,
  body
) {
  const octokit = await getInstallationOctokit(installationId);
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body,
  });
}

export function parseRepoFullName(fullName) {
  const parts = String(fullName || "").split("/");
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Descarrega zipball do GitHub (branch/ref) para ficheiro local.
 * @param {bigint|number|string} installationId
 * @param {string} repoFullName owner/repo
 * @param {string} ref branch ou tag
 * @param {string} destPath
 */
export async function downloadRepoZipballToFile(
  installationId,
  repoFullName,
  ref,
  destPath
) {
  const parsed = parseRepoFullName(repoFullName);
  if (!parsed) {
    throw Object.assign(new Error("repoFullName inválido"), { status: 400 });
  }
  const branch = String(ref || "main").trim() || "main";
  const { token } = await getInstallationAccessToken(installationId);
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/zipball/${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: githubApiHeaders(token),
    redirect: "follow",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(
      new Error(data.message || `GitHub zipball ${res.status}`),
      { status: res.status === 404 ? 404 : 502, code: "github_zipball_failed" }
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 22) {
    throw Object.assign(new Error("Zipball GitHub vazio"), {
      status: 502,
      code: "github_zipball_empty",
    });
  }
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
}

/**
 * Ensures a branch exists. If it doesn't, creates it from sourceBranch (or repo default).
 * Handles completely empty repos (no commits) by creating initial content.
 * @returns {Promise<boolean>} true if branch was created, false if already existed
 */
export async function ensureBranchExists(installationId, owner, repo, branchName, sourceBranch) {
  const octokit = await getInstallationOctokit(installationId);
  try {
    await octokit.repos.getBranch({ owner, repo, branch: branchName });
    return false;
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  const source = sourceBranch || await getRepoDefaultBranch(installationId, owner, repo).catch(() => null);
  let sha;

  if (source) {
    try {
      const { data } = await octokit.repos.getBranch({ owner, repo, branch: source });
      sha = data.commit.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }

  if (!sha) {
    try {
      const { data: commits } = await octokit.repos.listCommits({ owner, repo, per_page: 1 });
      if (commits.length > 0) sha = commits[0].sha;
    } catch (e) {
      if (e.status !== 409 && e.status !== 404) throw e;
    }
  }

  if (!sha) {
    const content = Buffer.from(`# ${repo}\n\nInitialized by AI Factory.\n`).toString("base64");
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "chore: initialize repository",
      content,
      branch: branchName,
    });
    return true;
  }

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha,
  });
  return true;
}

/**
 * Ensures a branch has at least one file. If empty/non-existent, commits a README.md.
 * @returns {Promise<boolean>} true if content was added, false if already had content
 */
export async function ensureBranchHasContent(installationId, owner, repo, branch) {
  const octokit = await getInstallationOctokit(installationId);
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: "", ref: branch });
    if (Array.isArray(data) && data.length > 0) return false;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  try {
    const content = Buffer.from(`# ${repo}\n\nInitialized by AI Factory.\n`).toString("base64");
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "chore: initialize branch with README",
      content,
      branch,
    });
    return true;
  } catch (e) {
    if (e.status === 422 && /sha/i.test(e.message)) return false;
    throw e;
  }
}
