import { query } from "../db/pool.js";
import { log } from "../lib/logger.js";
import { tenantWorkspacesDir } from "../lib/tenant-paths.js";
import {
  deployDirectoryHasFiles,
} from "../lib/deploy-workspace-filter.js";
import { getProjectStatus } from "./project-completion-service.js";
import { assertPlatformGitConfigured } from "./managed-git-service.js";
import { buildRailwayProjectName } from "./deploy-git-service.js";
import {
  assertClientRailwayConfig,
  applyClientServiceConfig,
  commitStagedEnvironment,
  createRailwayProject,
  fetchServiceInstance,
  getProjectDefaultEnvironment,
  listProjectServices,
  resolveOrCreateEmptyService,
  resolveRailwayPublicDomain,
  serviceInstanceHasRepo,
  triggerWorkerRedeploy,
  waitForServiceInstance,
  railwayStep,
  listServiceDeployments,
  fetchBuildLogs,
  formatBuildLogSnippet,
  waitForLatestDeploymentOutcome,
} from "../lib/railway-api.js";
import path from "node:path";

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function getRailwayDeploymentRow(tenantId, slug) {
  const { rows } = await query(
    `SELECT * FROM project_railway_deployments
     WHERE tenant_id = $1 AND project_slug = $2`,
    [tenantId, slug]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {Partial<object>} patch
 */
export async function upsertRailwayDeployment(tenantId, slug, patch) {
  const fields = [];
  const values = [tenantId, slug];
  let idx = 3;

  const allowed = [
    "status",
    "deploy_repo_full_name",
    "deploy_branch",
    "topology",
    "verdict",
    "blockers",
    "railway_project_id",
    "railway_environment_id",
    "railway_services",
    "public_url",
    "last_job_id",
    "last_error",
    "deployed_at",
  ];

  for (const key of allowed) {
    if (patch[key] !== undefined) {
      const isJson = key === "blockers" || key === "railway_services";
      fields.push(
        isJson ? `${key} = $${idx}::jsonb` : `${key} = $${idx}`
      );
      values.push(
        isJson ? JSON.stringify(patch[key]) : patch[key]
      );
      idx += 1;
    }
  }

  if (fields.length === 0) return;

  await query(
    `INSERT INTO project_railway_deployments (tenant_id, project_slug)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, project_slug) DO NOTHING`,
    [tenantId, slug]
  );

  await query(
    `UPDATE project_railway_deployments
     SET ${fields.join(", ")}, updated_at = now()
     WHERE tenant_id = $1 AND project_slug = $2`,
    values
  );
}

/**
 * @param {string} tenantId
 * @param {string} slug
 */
export async function assertCanPublish(tenantId, slug) {
  const status = await getProjectStatus(tenantId, slug);
  if (status.status !== "completed") {
    throw Object.assign(
      new Error("Publicação disponível apenas para projetos finalizados."),
      { status: 403, code: "project_not_completed" }
    );
  }

  const wsDir = path.join(tenantWorkspacesDir(tenantId), slug);
  if (!deployDirectoryHasFiles(wsDir)) {
    throw Object.assign(
      new Error("Não há código deployável no workspace."),
      { status: 404, code: "deploy_workspace_empty" }
    );
  }

  assertPlatformGitConfigured();
  assertClientRailwayConfig();
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {string} userId
 */
export async function startPublishJob(tenantId, slug, userId) {
  await assertCanPublish(tenantId, slug);
  await upsertRailwayDeployment(tenantId, slug, {
    status: "analyzing",
    last_error: null,
    verdict: null,
    blockers: null,
  });
  const { jobId } = await queueRailwayPublishJob(tenantId, slug, userId);
  await upsertRailwayDeployment(tenantId, slug, {
    status: "analyzing",
    last_job_id: jobId,
  });
  const { broadcast } = await import("../lib/ws-hub.js");
  broadcast(tenantId, { type: "dashboard", project: slug, reason: "railway-publish" });
  return { jobId };
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {string} userId
 */
async function queueRailwayPublishJob(tenantId, slug, userId) {
  const { randomUUID } = await import("node:crypto");
  const { canStartJob } = await import("../billing/index.js");
  const { query: q } = await import("../db/pool.js");

  const { rows: tenants } = await q(
    `SELECT balance_usd, has_active_job, agent_slots_max, agent_slots_in_use
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const t = tenants[0];
  if (!t) throw Object.assign(new Error("Tenant não encontrado"), { status: 404 });

  const check = canStartJob(Number(t.balance_usd), t.has_active_job);
  if (!check.allowed) {
    throw Object.assign(
      new Error("Saldo insuficiente para nova execução"),
      { status: 402, code: check.reason }
    );
  }
  if (t.agent_slots_in_use >= t.agent_slots_max) {
    throw Object.assign(new Error("Todos os slots ocupados"), { status: 429 });
  }

  const id = randomUUID();
  await q(
    `INSERT INTO jobs (id, tenant_id, project_slug, kind, macro_id, status, requested_by_user_id)
     VALUES ($1, $2, $3, 'railway-publish', $3, 'queued', $4)`,
    [id, tenantId, slug, userId]
  );
  return { jobId: id, kind: "railway-publish" };
}

/**
 * @param {unknown} readiness
 */
function validateReadiness(readiness) {
  if (!readiness || typeof readiness !== "object") {
    throw Object.assign(new Error("readiness inválido"), { status: 400 });
  }
  const r = /** @type {Record<string, unknown>} */ (readiness);
  if (!r.verdict || typeof r.verdict !== "string") {
    throw Object.assign(new Error("readiness.verdict obrigatório"), { status: 400 });
  }
  return r;
}

/**
 * @param {Record<string, unknown>} readiness
 */
function resolveInfra(readiness) {
  const infra = /** @type {Record<string, unknown>} */ (readiness.infra || {});
  return {
    postgres:
      /** @type {{ required?: boolean } | undefined} */ (infra.postgres) ||
      /** @type {{ required?: boolean } | undefined} */ (readiness.postgres),
    redis: /** @type {{ required?: boolean } | undefined} */ (infra.redis),
  };
}

/**
 * @param {object} svcDef
 * @param {{ postgresServiceId?: string|null, redisServiceId?: string|null, serviceNames: Set<string> }} ctx
 */
function buildServiceEnv(svcDef, ctx) {
  const name = String(svcDef.name || "app").trim() || "app";
  /** @type {Record<string, string>} */
  const vars = { ...(svcDef.env || {}) };

  if (ctx.postgresServiceId && name !== "postgres" && !vars.DATABASE_URL) {
    vars.DATABASE_URL = "${{postgres.DATABASE_URL}}";
  }
  if (ctx.redisServiceId && name !== "redis" && !vars.REDIS_URL) {
    vars.REDIS_URL = "${{redis.REDIS_URL}}";
  }
  if (
    name === "frontend" &&
    ctx.serviceNames.has("backend") &&
    !vars.VITE_API_URL &&
    !vars.REACT_APP_API_URL &&
    !vars.NEXT_PUBLIC_API_URL
  ) {
    vars.VITE_API_URL = "https://${{backend.RAILWAY_PUBLIC_DOMAIN}}";
    vars.REACT_APP_API_URL = "https://${{backend.RAILWAY_PUBLIC_DOMAIN}}";
  }

  return vars;
}

/**
 * @param {Record<string, unknown>} readiness
 * @param {Array<{ name: string, serviceId: string }>} railwayServices
 */
function resolvePublicServiceName(readiness, railwayServices) {
  const explicit = String(readiness.publicService || "").trim();
  if (explicit && railwayServices.some((s) => s.name === explicit)) {
    return explicit;
  }
  const appType = String(readiness.appType || "");
  if (appType === "fullstack") {
    return (
      railwayServices.find((s) => s.name === "frontend")?.name ||
      railwayServices.find((s) => s.name === "app")?.name ||
      railwayServices[0]?.name
    );
  }
  if (appType === "frontend") {
    return (
      railwayServices.find((s) => s.name === "frontend" || s.name === "app")
        ?.name || railwayServices[0]?.name
    );
  }
  return (
    railwayServices.find((s) => s.name === "app" || s.name === "backend")
      ?.name || railwayServices[0]?.name
  );
}

/**
 * @param {Array<Record<string, unknown>>} services
 */
function sortAppServices(services) {
  const rank = { backend: 0, app: 1, frontend: 2 };
  return [...services].sort(
    (a, b) =>
      (rank[String(a.name)] ?? 9) - (rank[String(b.name)] ?? 9)
  );
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {{ readiness: unknown, deployRepoFullName: string, deployBranch?: string }} input
 */
export async function provisionFromRepo(tenantId, slug, input) {
  const readiness = validateReadiness(input.readiness);
  const deployBranch =
    String(input.deployBranch || "tech-lead").trim() || "tech-lead";
  const deployRepoFullName = String(input.deployRepoFullName || "").trim();
  if (!deployRepoFullName) {
    throw Object.assign(new Error("deployRepoFullName obrigatório"), { status: 400 });
  }

  if (readiness.verdict !== "deployable") {
    await upsertRailwayDeployment(tenantId, slug, {
      status: "not_deployable",
      verdict: readiness.verdict,
      topology: readiness.topology || null,
      blockers: readiness.blockers || [],
      last_error: readiness.summary || "Não deployável",
      deploy_repo_full_name: deployRepoFullName,
      deploy_branch: deployBranch,
    });
    return {
      provisioned: false,
      verdict: readiness.verdict,
      blockers: readiness.blockers || [],
    };
  }

  const services = Array.isArray(readiness.services) ? readiness.services : [];
  if (services.length === 0) {
    throw Object.assign(new Error("readiness.services vazio"), { status: 400 });
  }

  await upsertRailwayDeployment(tenantId, slug, {
    status: "provisioning",
    verdict: readiness.verdict,
    topology: readiness.topology || null,
    deploy_repo_full_name: deployRepoFullName,
    deploy_branch: deployBranch,
    blockers: [],
    last_error: null,
  });

  const cfg = assertClientRailwayConfig();
  let row = await getRailwayDeploymentRow(tenantId, slug);
  let railwayProjectId = row?.railway_project_id || null;
  let environmentId = row?.railway_environment_id || null;

  if (!railwayProjectId) {
    const projectName = buildRailwayProjectName(tenantId, slug);
    const created = await railwayStep("projectCreate", () =>
      createRailwayProject(projectName, cfg.workspaceId)
    );
    railwayProjectId = created.id;
    const env = await railwayStep("getProjectDefaultEnvironment", () =>
      getProjectDefaultEnvironment(railwayProjectId)
    );
    environmentId = env.id;
    await upsertRailwayDeployment(tenantId, slug, {
      railway_project_id: railwayProjectId,
      railway_environment_id: environmentId,
    });
  } else if (!environmentId) {
    const env = await getProjectDefaultEnvironment(railwayProjectId);
    environmentId = env.id;
    await upsertRailwayDeployment(tenantId, slug, {
      railway_environment_id: environmentId,
    });
  }

  /** @type {Array<{ serviceId: string, name: string, publicUrl?: string }>} */
  const railwayServices = [];
  let postgresServiceId = null;
  let redisServiceId = null;

  const infra = resolveInfra(readiness);
  const postgres = infra.postgres;
  const redis = infra.redis;

  if (postgres?.required) {
    const existingPg = (row?.railway_services || []).find(
      (s) => s?.name === "postgres"
    );
    if (existingPg?.serviceId) {
      postgresServiceId = existingPg.serviceId;
    } else {
      const pgSvc = await railwayStep("createPostgresService", () =>
        resolveOrCreateEmptyService({
          projectId: railwayProjectId,
          environmentId,
          name: "postgres",
        })
      );
      postgresServiceId = pgSvc.id;
      railwayServices.push({ serviceId: pgSvc.id, name: "postgres" });
    }
  }

  if (redis?.required) {
    const existingRedis = (row?.railway_services || []).find(
      (s) => s?.name === "redis"
    );
    if (existingRedis?.serviceId) {
      redisServiceId = existingRedis.serviceId;
    } else {
      const redisSvc = await railwayStep("createRedisService", () =>
        resolveOrCreateEmptyService({
          projectId: railwayProjectId,
          environmentId,
          name: "redis",
        })
      );
      redisServiceId = redisSvc.id;
      railwayServices.push({ serviceId: redisSvc.id, name: "redis" });
    }
  }

  const existingByName = new Map(
    (Array.isArray(row?.railway_services) ? row.railway_services : []).map(
      (s) => [s.name, s.serviceId]
    )
  );

  if (railwayProjectId) {
    try {
      const remoteServices = await listProjectServices(railwayProjectId);
      for (const rs of remoteServices) {
        if (rs?.name && rs?.id && !existingByName.has(rs.name)) {
          existingByName.set(rs.name, rs.id);
        }
      }
    } catch (e) {
      log.warn("listProjectServices falhou — continuar com cache BD", {
        slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const appServices = sortAppServices(
    services.filter(
      (s) => !["postgres", "redis"].includes(String(s?.name || ""))
    )
  );
  const serviceNames = new Set(
    appServices.map((s) => String(s.name || "app"))
  );
  const envCtx = {
    postgresServiceId,
    redisServiceId,
    serviceNames,
  };

  for (const svcDef of appServices) {
    const name = String(svcDef.name || "app").trim() || "app";
    let serviceId = existingByName.get(name) || null;

    if (!serviceId) {
      const created = await railwayStep("serviceCreate", () =>
        resolveOrCreateEmptyService({
          projectId: railwayProjectId,
          environmentId,
          name,
        })
      );
      serviceId = created.id;
    }

    const { instance } = await fetchServiceInstance(serviceId, environmentId);
    const includeSource = !serviceInstanceHasRepo(instance, deployRepoFullName);

    const variables = buildServiceEnv(svcDef, envCtx);

    await railwayStep("applyClientServiceConfig", () =>
      applyClientServiceConfig({
        environmentId,
        serviceId,
        repo: deployRepoFullName,
        branch: deployBranch,
        rootDirectory: svcDef.rootDirectory,
        dockerfilePath: svcDef.dockerfilePath || "Dockerfile",
        variables,
        includeSource,
        sourceCommitMessage: `DevForLess ${slug}: repo ${deployBranch}`,
        configCommitMessage: `DevForLess ${slug}: ${name} deploy config`,
      })
    );

    railwayServices.push({ serviceId, name });
  }

  await railwayStep("commitStagedEnvironment", () =>
    commitStagedEnvironment(environmentId, `DevForLess deploy ${slug}`)
  );

  const publicName = resolvePublicServiceName(readiness, railwayServices);
  const primary = railwayServices.find((s) => s.name === publicName) ||
    railwayServices.find((s) => s.name === "app") ||
    railwayServices.find((s) => s.name === "frontend") ||
    railwayServices[0];
  if (primary) {
    await waitForServiceInstance(primary.serviceId, environmentId, {
      attempts: 20,
      delayMs: 3000,
    }).catch(() => {});

    const redeploy = await railwayStep("deployServiceInstance", () =>
      triggerWorkerRedeploy(environmentId, primary.serviceId, {
        postCommitDelayMs: 8000,
        deployAttempts: 6,
        deployDelayMs: 5000,
      })
    );

    if (redeploy.skipped) {
      log.info("Deploy Railway adiado — commit/push Git já dispararam build", {
        slug,
        reason: redeploy.reason,
      });
    } else if (redeploy.deploymentId) {
      primary.lastDeploymentId = redeploy.deploymentId;
    }

    const domain = await resolveRailwayPublicDomain(
      environmentId,
      primary.serviceId,
      row?.public_url || null
    ).catch((e) => {
      log.warn("domainCreate/resolver falhou", { slug, error: e.message });
      return null;
    });
    if (domain?.domain) {
      primary.publicUrl = domain.domain.startsWith("http")
        ? domain.domain
        : `https://${domain.domain}`;
    }
  }

  const publicUrl = primary?.publicUrl || null;
  await upsertRailwayDeployment(tenantId, slug, {
    status: "verifying",
    railway_services: railwayServices,
    public_url: publicUrl,
    deployed_at: null,
    last_error: null,
  });

  log.info("Railway provision OK — aguarda verificação HTTP", {
    tenantId,
    slug,
    publicUrl,
  });

  return {
    provisioned: true,
    railwayProjectId,
    environmentId,
    publicUrl,
    services: railwayServices,
  };
}

/**
 * @param {number|null|undefined} exitCode
 */
const FRIENDLY_PUBLISH_FAILED =
  "Não foi possível publicar a aplicação automaticamente. " +
  "Tente novamente em alguns minutos.";

function railwayPublishJobErrorMessage(exitCode) {
  if (exitCode === 130) {
    return (
      "A publicação foi interrompida. Aguarde ou clique em Tentar novamente " +
      "com o worker activo."
    );
  }
  if (exitCode === 1) {
    return (
      "A publicação falhou (agente ou deploy demorou demais). " +
      "Tente novamente — o worker deve permanecer activo durante todo o processo."
    );
  }
  if (exitCode != null) {
    return FRIENDLY_PUBLISH_FAILED;
  }
  return FRIENDLY_PUBLISH_FAILED;
}

const IN_PROGRESS_PUBLISH_STATUSES = new Set([
  "analyzing",
  "syncing",
  "provisioning",
  "verifying",
]);

/**
 * Estado exposto ao frontend — oculta detalhes técnicos durante o processo.
 * @param {string} status
 * @param {boolean} jobActive
 */
function clientPublishStatus(status, jobActive) {
  if (jobActive && !IN_PROGRESS_PUBLISH_STATUSES.has(status)) {
    if (status === "failed" || status === "not_deployable" || status === "verifying") {
      return status === "verifying" ? "verifying" : "analyzing";
    }
  }
  if (status === "not_deployable") return "failed";
  return status;
}

/**
 * @param {string|null} status
 * @param {string|null} jobStatus
 */
function clientPublishHint(status, jobStatus) {
  if (jobStatus === "queued") {
    return "Publicação na fila — aguarde, o processo continuará automaticamente.";
  }
  const map = {
    analyzing:
      "A analisar o código e preparar o deploy. Aguarde — pode levar vários minutos.",
    syncing: "A enviar código para o repositório de deploy…",
    provisioning: "A publicar no Railway…",
    verifying:
      "Deploy enviado — a confirmar que a aplicação está online. Aguarde cerca de 2 minutos.",
  };
  if (status && map[status]) return map[status];
  if (IN_PROGRESS_PUBLISH_STATUSES.has(status || "")) {
    return "Publicação em andamento. Não feche esta página.";
  }
  return null;
}

export async function getPublishStatus(tenantId, slug) {
  const row = await getRailwayDeploymentRow(tenantId, slug);

  /** @type {{ id: string, status: string, created_at: Date, started_at: Date|null, finished_at: Date|null, exit_code: number|null } | null} */
  let linkedJob = null;
  if (row?.last_job_id) {
    const { rows } = await query(
      `SELECT id, status, created_at, started_at, finished_at, exit_code
       FROM jobs WHERE id = $1 AND tenant_id = $2`,
      [row.last_job_id, tenantId]
    );
    linkedJob = rows[0] || null;
  }

  const { rows: latestRows } = await query(
    `SELECT id, status, created_at, started_at, finished_at, exit_code
     FROM jobs
     WHERE tenant_id = $1 AND project_slug = $2 AND kind = 'railway-publish'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, slug]
  );
  const latestJob = latestRows[0] || null;

  const isActive = (j) =>
    j && (j.status === "running" || j.status === "queued");

  /** Prefer job activo (último ou ligado) para evitar UI presa num failed órfão. */
  let job = latestJob;
  if (isActive(linkedJob)) {
    job = linkedJob;
  } else if (isActive(latestJob)) {
    job = latestJob;
  } else if (linkedJob) {
    job = linkedJob;
  }

  let status = row?.status || "idle";
  let lastError = row?.last_error || null;

  if (isActive(job) && status === "failed") {
    status = "analyzing";
    lastError = null;
  }

  if (
    job?.status === "failed" &&
    IN_PROGRESS_PUBLISH_STATUSES.has(status)
  ) {
    status = "failed";
    lastError = lastError || railwayPublishJobErrorMessage(job.exit_code);
    await upsertRailwayDeployment(tenantId, slug, {
      status,
      last_error: lastError,
    });
  }

  const jobActive = isActive(job);
  const clientStatus = clientPublishStatus(status, jobActive);
  const showPublicUrl = clientStatus === "deployed" && row?.public_url;

  if (
    job?.status === "queued" &&
    clientStatus === "analyzing" &&
    job.created_at
  ) {
    const ageMs = Date.now() - new Date(job.created_at).getTime();
    if (ageMs > 3 * 60 * 1000 && !jobActive) {
      lastError =
        lastError ||
        "O job continua na fila. Verifique se o worker CLI está a correr.";
    }
  }

  const hint = clientPublishHint(clientStatus, job?.status ?? null);
  const clientError =
    jobActive || IN_PROGRESS_PUBLISH_STATUSES.has(clientStatus)
      ? null
      : job?.status === "failed"
        ? railwayPublishJobErrorMessage(job.exit_code) || lastError
        : lastError;

  return {
    status: clientStatus,
    verdict: null,
    topology: row?.topology ?? null,
    blockers: [],
    publicUrl: showPublicUrl ? row.public_url : null,
    deployRepoFullName: row?.deploy_repo_full_name ?? null,
    railwayProjectId: row?.railway_project_id ?? null,
    railwayServices: [],
    lastError: clientError,
    lastJobId: row?.last_job_id ?? job?.id ?? null,
    deployedAt: clientStatus === "deployed" ? row?.deployed_at ?? null : null,
    jobStatus: job?.status ?? null,
    jobId: job?.id ?? null,
    jobCreatedAt: job?.created_at ?? null,
    jobStartedAt: job?.started_at ?? null,
    jobFinishedAt: job?.finished_at ?? null,
    hint,
  };
}

/**
 * Resolve serviço app principal a partir do registo Railway.
 * @param {object|null|undefined} row
 */
function resolvePrimaryRailwayService(row) {
  const services = Array.isArray(row?.railway_services) ? row.railway_services : [];
  return (
    services.find((s) => s?.name === "app") ||
    services.find((s) => s?.name === "frontend") ||
    services[0] ||
    null
  );
}

/**
 * Logs e estado do último build Railway — para diagnóstico quando HTTP verify falha.
 * @param {string} tenantId
 * @param {string} slug
 */
export async function getRailwayBuildDiagnostics(tenantId, slug) {
  const row = await getRailwayDeploymentRow(tenantId, slug);
  if (!row?.railway_project_id) {
    return { ok: false, reason: "no_railway_project" };
  }

  const primary = resolvePrimaryRailwayService(row);
  if (!primary?.serviceId) {
    return { ok: false, reason: "no_service" };
  }

  let deploymentId = primary.lastDeploymentId || null;
  let deploymentStatus = null;

  const deployments = await listServiceDeployments({
    projectId: row.railway_project_id,
    serviceId: primary.serviceId,
    environmentId: row.railway_environment_id || undefined,
    first: 5,
  }).catch(() => []);

  if (deployments.length > 0) {
    const match = deploymentId
      ? deployments.find((d) => d.id === deploymentId)
      : null;
    const chosen = match || deployments[0];
    deploymentId = chosen.id;
    deploymentStatus = chosen.status;
  }

  if (!deploymentId) {
    const latest = await waitForLatestDeploymentOutcome({
      projectId: row.railway_project_id,
      serviceId: primary.serviceId,
      environmentId: row.railway_environment_id || undefined,
      attempts: 3,
      delayMs: 5000,
    }).catch(() => null);
    deploymentId = latest?.id || null;
    deploymentStatus = latest?.status || null;
  }

  if (!deploymentId) {
    return { ok: false, reason: "no_deployment" };
  }

  /** @type {Array<{ message?: string }>} */
  let buildLogs = [];
  try {
    buildLogs = await fetchBuildLogs(deploymentId, { limit: 500 });
  } catch (e) {
    log.warn("fetchBuildLogs falhou", {
      slug,
      deploymentId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const buildLogSnippet = formatBuildLogSnippet(buildLogs);
  const buildFailed =
    deploymentStatus === "FAILED" || deploymentStatus === "CRASHED";

  return {
    ok: true,
    deploymentId,
    deploymentStatus,
    buildFailed,
    buildLogSnippet,
    serviceId: primary.serviceId,
    serviceName: primary.name || "app",
  };
}

/**
 * @param {string} tenantId
 * @param {string} slug
 * @param {string} status
 * @param {string} [error]
 */
export async function setPublishJobOutcome(tenantId, slug, status, error = null) {
  /** @type {Record<string, unknown>} */
  const patch = { status, last_error: error };

  if (status === "deployed") {
    patch.deployed_at = new Date();
    patch.last_error = null;
  }
  if (status === "failed") {
    patch.last_error = error || FRIENDLY_PUBLISH_FAILED;
  }

  await upsertRailwayDeployment(tenantId, slug, patch);
}
