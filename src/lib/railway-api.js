const RAILWAY_GRAPHQL_URL =
  process.env.RAILWAY_GRAPHQL_URL || "https://backboard.railway.com/graphql/v2";

/** Repo GitHub do worker CLI (1 repo para todos os tenants). ENV sobrescreve. */
export const DEFAULT_RAILWAY_CLI_REPO = "cloudsystec/AI-ai-factory-cli";
export const DEFAULT_RAILWAY_CLI_BRANCH = "main";
/** US West (California) — fallback só se volumeCreate exigir region e API não devolver */
export const DEFAULT_RAILWAY_CLI_REGION = "us-west1";

/** Mount path do volume por tenant (igual ao CLI docker-entrypoint). */
export function workerTenantMountPath(tenantId) {
  return `/app/data/tenants/${String(tenantId)}`;
}

export function railwayCliRepo() {
  return process.env.RAILWAY_CLI_REPO || DEFAULT_RAILWAY_CLI_REPO;
}

export function railwayCliBranch() {
  return process.env.RAILWAY_CLI_BRANCH || DEFAULT_RAILWAY_CLI_BRANCH;
}

export function railwayCliRegion() {
  return (
    process.env.RAILWAY_CLI_REGION ||
    process.env.RAILWAY_DEFAULT_REGION ||
    DEFAULT_RAILWAY_CLI_REGION
  );
}

/** Nome único por tenant (evita colisão cli-bb6d9ded → cli-bb6d9ded-uuid…). */
export function workerServiceName(tenantId) {
  return `cli-${String(tenantId)}`;
}

/**
 * @param {string | null | undefined} serviceName
 * @param {string} tenantId
 */
export function isWorkerServiceNameValid(serviceName, tenantId) {
  return serviceName === workerServiceName(tenantId);
}

/**
 * @param {unknown} instance
 * @param {string} [repo]
 */
export function serviceInstanceHasRepo(instance, repo = railwayCliRepo()) {
  const connected = /** @type {{ source?: { repo?: string } } | null} */ (
    instance
  )?.source?.repo;
  if (!connected) return false;
  const expected = repo.toLowerCase();
  const actual = String(connected).toLowerCase();
  return actual === expected || actual.endsWith(`/${expected.split("/")[1]}`);
}

/** Por defeito inclui build Docker no provisionamento. Só skip com RAILWAY_WORKER_SKIP_BUILD=true */
export function workerSkipsBuildOnProvision() {
  return process.env.RAILWAY_WORKER_SKIP_BUILD === "true";
}

/** Por defeito cria volume em /app/data/tenants/<uuid>. Skip com RAILWAY_WORKER_SKIP_VOLUME=true */
export function workerSkipsVolumeOnProvision() {
  return process.env.RAILWAY_WORKER_SKIP_VOLUME === "true";
}

/**
 * Serviço criado no Railway com nome certo e instância no ambiente.
 * @param {unknown} service
 * @param {unknown} instance
 * @param {string} tenantId
 */
export function isWorkerServiceConfigured(service, instance, tenantId) {
  const svc = /** @type {{ id?: string, name?: string } | null} */ (service);
  if (!svc?.id || !instance) return false;
  return isWorkerServiceNameValid(svc.name, tenantId);
}

export function isWorkerServiceHealthy(service, instance, tenantId) {
  if (!isWorkerServiceConfigured(service, instance, tenantId)) return false;
  return serviceInstanceHasRepo(instance);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 */
export async function railwayGraphql(query, variables = {}) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    throw new Error("RAILWAY_API_TOKEN não configurado");
  }

  const res = await fetch(RAILWAY_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Railway HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`
    );
  }
  if (body.errors?.length) {
    const detail = body.errors
      .map((e) => {
        const parts = [e.message];
        if (e.extensions?.code) parts.push(`code=${e.extensions.code}`);
        if (e.path) parts.push(`path=${JSON.stringify(e.path)}`);
        return parts.filter(Boolean).join(" ");
      })
      .join("; ");
    throw new Error(detail || "Railway GraphQL error");
  }
  return body.data;
}

/**
 * @param {string} serviceId
 * @param {string} environmentId
 */
export async function fetchServiceInstance(serviceId, environmentId) {
  const data = await railwayGraphql(
    `query ServiceInstance($environmentId: String!, $serviceId: String!) {
      serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
        region
        builder
        dockerfilePath
        rootDirectory
        startCommand
        source {
          image
          repo
        }
      }
      service(id: $serviceId) {
        id
        name
      }
    }`,
    { environmentId, serviceId }
  );
  return {
    instance: data?.serviceInstance ?? null,
    service: data?.service ?? null,
  };
}

/**
 * @param {unknown} err
 */
export function isRailwayAlreadyExistsError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(msg);
}

/**
 * @param {string} projectId
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listProjectServices(projectId) {
  const data = await railwayGraphql(
    `query ProjectServices($projectId: String!) {
      project(id: $projectId) {
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }`,
    { projectId }
  );
  return (data?.project?.services?.edges || [])
    .map((e) => e?.node)
    .filter((n) => n?.id && n?.name);
}

/**
 * Cria serviço ou reutiliza existente com o mesmo nome (retry após falha parcial).
 * @param {{ projectId: string, environmentId: string, name: string }} input
 */
export async function resolveOrCreateEmptyService(input) {
  try {
    return await createEmptyWorkerService(input);
  } catch (e) {
    if (!isRailwayAlreadyExistsError(e)) throw e;
    const services = await listProjectServices(input.projectId);
    const found = services.find((s) => s.name === input.name);
    if (!found?.id) throw e;
    return found;
  }
}

/**
 * @param {string} environmentId
 * @param {string} serviceId
 * @returns {Promise<Array<{ id: string, domain: string }>>}
 */
export async function listServiceRailwayDomains(environmentId, serviceId) {
  const data = await railwayGraphql(
    `query ServiceDomains($environmentId: String!, $serviceId: String!) {
      domains(environmentId: $environmentId, serviceId: $serviceId) {
        serviceDomains {
          id
          domain
        }
      }
    }`,
    { environmentId, serviceId }
  );
  const list = data?.domains?.serviceDomains;
  return Array.isArray(list) ? list.filter((d) => d?.domain) : [];
}

/**
 * @param {string} environmentId
 * @param {string} serviceId
 * @param {string|null|undefined} [fallbackUrl]
 */
export async function resolveRailwayPublicDomain(
  environmentId,
  serviceId,
  fallbackUrl = null
) {
  if (fallbackUrl) {
    const host = fallbackUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return host ? { domain: host } : null;
  }

  try {
    const created = await createRailwayPublicDomain(environmentId, serviceId);
    if (created?.domain) return created;
  } catch (e) {
    if (!isRailwayAlreadyExistsError(e)) {
      const existing = await listServiceRailwayDomains(environmentId, serviceId).catch(
        () => []
      );
      if (existing[0]?.domain) return existing[0];
    }
  }

  const existing = await listServiceRailwayDomains(environmentId, serviceId).catch(
    () => []
  );
  if (existing[0]?.domain) return existing[0];
  return null;
}

/**
 * Cria serviço vazio (sem repo) — evita build imediato; repo entra no staging.
 * @param {{ projectId: string, environmentId: string, name: string }} input
 */
export async function createEmptyWorkerService(input) {
  const data = await railwayGraphql(
    `mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.name,
      },
    }
  );
  const svc = data?.serviceCreate;
  if (!svc?.id) throw new Error("serviceCreate não devolveu id");
  return svc;
}

/**
 * Cria serviço já ligado ao repo (dispara build) — usar só em deploy explícito.
 * @param {{ projectId: string, environmentId: string, name: string, repo?: string, branch?: string }} input
 */
export async function createWorkerService(input) {
  const repo = input.repo || railwayCliRepo();
  const branch = input.branch || railwayCliBranch();
  const data = await railwayGraphql(
    `mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        name: input.name,
        source: { repo },
        branch,
      },
    }
  );
  const svc = data?.serviceCreate;
  if (!svc?.id) throw new Error("serviceCreate não devolveu id");
  return svc;
}

/**
 * @param {string} serviceId
 * @param {string} name
 */
export async function updateServiceName(serviceId, name) {
  const data = await railwayGraphql(
    `mutation ServiceUpdate($id: String!, $input: ServiceUpdateInput!) {
      serviceUpdate(id: $id, input: $input) { id name }
    }`,
    { id: serviceId, input: { name } }
  );
  return data?.serviceUpdate ?? null;
}

/**
 * @param {string} serviceId
 */
export async function deleteRailwayService(serviceId) {
  await railwayGraphql(
    `mutation ServiceDelete($id: String!) {
      serviceDelete(id: $id)
    }`,
    { id: serviceId }
  );
}

/** @deprecated Usar createEmptyWorkerService */
export async function createEmptyService(input) {
  return createEmptyWorkerService(input);
}

/**
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @template T
 */
export async function railwayStep(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[${label}] ${msg}`);
  }
}

/**
 * @param {Record<string, string>} variables
 */
export function toStagedVariableMap(variables) {
  /** @type {Record<string, { value: string }>} */
  const out = {};
  for (const [key, value] of Object.entries(variables)) {
    out[key] = { value: String(value) };
  }
  return out;
}

/**
 * Configura source, região, builder e variáveis via staged changes (API recomendada).
 * @param {string} environmentId
 * @param {string} serviceId
 * @param {{
 *   repo: string,
 *   branch: string,
 *   variables: Record<string, string>,
 *   isCreated?: boolean,
 *   dockerfilePath?: string,
 *   includeSource?: boolean,
 *   configOnly?: boolean,
 * }} config
 */
export async function stageWorkerServiceConfig(environmentId, serviceId, config) {
  const configOnly = config.configOnly === true;

  /** @type {Record<string, unknown>} */
  const servicePatch = {
    variables: toStagedVariableMap(config.variables),
  };

  if (config.isCreated === true) {
    servicePatch.isCreated = true;
  }

  if (config.includeSource !== false && config.repo) {
    servicePatch.source = { repo: config.repo, branch: config.branch };
  }

  if (!configOnly && config.dockerfilePath) {
    servicePatch.build = {
      builder: "DOCKERFILE",
      dockerfilePath: config.dockerfilePath,
    };
  }

  // Não enviar deploy.multiRegionConfig — região fica no default do project/Railway.
  // Enviar região com merge:true acumula US West + Oregon e quebra volume (1 região só).

  await railwayGraphql(
    `mutation StageWorker($environmentId: String!, $input: EnvironmentConfig!, $merge: Boolean) {
      environmentStageChanges(
        environmentId: $environmentId
        input: $input
        merge: $merge
      ) { id }
    }`,
    {
      environmentId,
      merge: true,
      input: { services: { [serviceId]: servicePatch } },
    }
  );
}

/**
 * @param {string} environmentId
 * @param {string} [message]
 * @param {{ skipDeploys?: boolean }} [opts]
 */
export async function commitStagedEnvironment(environmentId, message, opts = {}) {
  await railwayGraphql(
    `mutation CommitStaged($environmentId: String!, $message: String, $skipDeploys: Boolean) {
      environmentPatchCommitStaged(
        environmentId: $environmentId
        commitMessage: $message
        skipDeploys: $skipDeploys
      )
    }`,
    {
      environmentId,
      message: message || "AI Factory worker provision",
      skipDeploys: opts.skipDeploys === true,
    }
  );
}

/**
 * @param {{ projectId: string, environmentId: string, serviceId: string, mountPath: string, region?: string }} input
 */
export async function createVolume(input) {
  /** @type {Record<string, unknown>} */
  const volInput = {
    projectId: input.projectId,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    mountPath: input.mountPath,
  };
  if (input.region) {
    volInput.region = input.region;
  }

  const data = await railwayGraphql(
    `mutation VolumeCreate($input: VolumeCreateInput!) {
      volumeCreate(input: $input) { id name }
    }`,
    { input: volInput }
  );
  const vol = data?.volumeCreate;
  if (!vol?.id) throw new Error("volumeCreate não devolveu id");
  return vol;
}

/**
 * Região do serviço no ambiente (para volumeCreate); fallback ENV/default.
 * @param {string} serviceId
 * @param {string} environmentId
 */
export async function resolveServiceRegion(serviceId, environmentId) {
  const { instance } = await fetchServiceInstance(serviceId, environmentId);
  const fromInstance = /** @type {{ region?: string } | null} */ (instance)?.region;
  if (fromInstance) return fromInstance;
  return railwayCliRegion();
}

/**
 * Aguarda ServiceInstance aparecer após commit (Railway aplica async).
 * @param {string} serviceId
 * @param {string} environmentId
 * @param {{ attempts?: number, delayMs?: number }} [opts]
 */
export async function waitForServiceInstance(
  serviceId,
  environmentId,
  opts = {}
) {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 3000;

  for (let i = 0; i < attempts; i++) {
    const { instance } = await fetchServiceInstance(serviceId, environmentId);
    if (instance) return instance;
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw new Error(
    `ServiceInstance não apareceu no ambiente após ${attempts} tentativas`
  );
}

/**
 * @param {string} environmentId
 * @param {string} serviceId
 */
export async function deployServiceInstance(environmentId, serviceId) {
  const data = await railwayGraphql(
    `mutation ServiceInstanceDeployV2($environmentId: String!, $serviceId: String!) {
      serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId)
    }`,
    { environmentId, serviceId }
  );
  return data?.serviceInstanceDeployV2 ?? null;
}

/**
 * @param {{ projectId: string, serviceId: string, environmentId?: string, first?: number }} input
 * @returns {Promise<Array<{ id: string, status: string, createdAt?: string }>>}
 */
export async function listServiceDeployments(input) {
  const first = input.first ?? 5;
  /** @type {Record<string, string>} */
  const gqlInput = {
    projectId: input.projectId,
    serviceId: input.serviceId,
  };
  if (input.environmentId) {
    gqlInput.environmentId = input.environmentId;
  }

  const data = await railwayGraphql(
    `query Deployments($first: Int!, $input: DeploymentListInput!) {
      deployments(first: $first, input: $input) {
        edges {
          node {
            id
            status
            createdAt
          }
        }
      }
    }`,
    { first, input: gqlInput }
  );

  return (data?.deployments?.edges || [])
    .map((e) => e?.node)
    .filter((n) => n?.id);
}

/**
 * @param {string} deploymentId
 * @param {{ limit?: number, filter?: string }} [opts]
 * @returns {Promise<Array<{ message?: string, timestamp?: string, severity?: string }>>}
 */
export async function fetchBuildLogs(deploymentId, opts = {}) {
  const limit = opts.limit ?? 500;
  const filter = opts.filter ?? "";

  try {
    const data = await railwayGraphql(
      `query BuildLogs($deploymentId: String!, $limit: Int!, $filter: String) {
        buildLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
          message
          timestamp
          severity
        }
      }`,
      { deploymentId, limit, filter }
    );
    return data?.buildLogs || [];
  } catch {
    const data = await railwayGraphql(
      `query BuildLogsUnion($deploymentId: String!, $limit: Int!, $filter: String) {
        buildLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
          __typename
          ... on Log {
            message
            timestamp
            severity
          }
        }
      }`,
      { deploymentId, limit, filter }
    );
    return data?.buildLogs || [];
  }
}

const BUILD_LOG_ERROR_RE =
  /error|failed|fatal|not found|exit code|cannot|denied|ENOENT|no such file/i;

/**
 * Extrai trecho útil dos logs de build (erros + cauda).
 * @param {Array<{ message?: string }>} logs
 * @param {number} [maxLines]
 */
export function formatBuildLogSnippet(logs, maxLines = 80) {
  const lines = (logs || [])
    .map((l) => String(l?.message || "").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const errorLines = lines.filter((l) => BUILD_LOG_ERROR_RE.test(l));
  const tail = lines.slice(-50);
  const merged = [...new Set([...errorLines.slice(-30), ...tail])];
  return merged.slice(-maxLines).join("\n");
}

/**
 * Aguarda deployment terminar (SUCCESS/FAILED/CRASHED) ou timeout.
 * @param {{ projectId: string, serviceId: string, environmentId?: string, attempts?: number, delayMs?: number }} input
 */
export async function waitForLatestDeploymentOutcome(input) {
  const attempts = input.attempts ?? 24;
  const delayMs = input.delayMs ?? 10_000;
  /** @type {{ id: string, status: string } | null} */
  let latest = null;

  for (let i = 0; i < attempts; i += 1) {
    const deployments = await listServiceDeployments({
      projectId: input.projectId,
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      first: 1,
    });
    latest = deployments[0] || null;
    if (!latest) {
      if (i < attempts - 1) await sleep(delayMs);
      continue;
    }
    const terminal = ["SUCCESS", "FAILED", "CRASHED", "SKIPPED"].includes(
      latest.status
    );
    if (terminal) return latest;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return latest;
}

/**
 * Redeploy após volume ou commit staged; tolera Railway ainda a processar.
 * O commit staged / push Git já podem disparar deploy — falha "not found" não é fatal.
 * @param {string} environmentId
 * @param {string} serviceId
 * @param {{ waitAttempts?: number, waitDelayMs?: number, postCommitDelayMs?: number, deployAttempts?: number, deployDelayMs?: number }} [opts]
 */
export async function triggerWorkerRedeploy(environmentId, serviceId, opts = {}) {
  const deployAttempts = opts.deployAttempts ?? 4;
  const deployDelayMs = opts.deployDelayMs ?? 5000;

  try {
    await waitForServiceInstance(serviceId, environmentId, {
      attempts: opts.waitAttempts ?? 10,
      delayMs: opts.waitDelayMs ?? 3000,
    });
  } catch {
    return { skipped: true, reason: "instance_not_ready" };
  }

  if (opts.postCommitDelayMs && opts.postCommitDelayMs > 0) {
    await sleep(opts.postCommitDelayMs);
  }

  for (let i = 0; i < deployAttempts; i++) {
    try {
      const deploymentId = await deployServiceInstance(environmentId, serviceId);
      return { skipped: false, deploymentId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|processing|Problem processing|INTERNAL_SERVER_ERROR/i.test(msg)) {
        if (i < deployAttempts - 1) {
          await sleep(deployDelayMs);
          continue;
        }
        return { skipped: true, reason: msg };
      }
      throw e;
    }
  }
  return { skipped: true, reason: "deploy_retries_exhausted" };
}

/**
 * Serviço sem instância no ambiente (ex.: serviceCreate antigo ou retry após falha cedo).
 * @param {unknown} instance
 */
export function needsServiceInstanceCreate(instance) {
  return instance == null;
}

/**
 * Configura e aplica deploy do worker (repo + env + região) via staged changes.
 * Repo Git é ligado em environmentStageChanges (source.repo) — não usar serviceConnect.
 * @param {{
 *   environmentId: string,
 *   serviceId: string,
 *   variables: Record<string, string>,
 *   includeSource?: boolean,
 *   createdFromRepo?: boolean,
 *   configOnly?: boolean,
 * }} input
 */
export async function applyWorkerServiceConfig(input) {
  const repo = railwayCliRepo();
  const branch = railwayCliBranch();
  const dockerfilePath = process.env.RAILWAY_CLI_DOCKERFILE_PATH || "Dockerfile";
  const configOnly =
    input.configOnly ?? workerSkipsBuildOnProvision();

  const { instance } = await railwayStep("fetchServiceInstance", () =>
    fetchServiceInstance(input.serviceId, input.environmentId)
  );

  const isCreated = needsServiceInstanceCreate(instance);
  const includeSource = !serviceInstanceHasRepo(instance);

  await railwayStep("environmentStageChanges", () =>
    stageWorkerServiceConfig(input.environmentId, input.serviceId, {
      repo,
      branch,
      variables: input.variables,
      isCreated,
      dockerfilePath,
      includeSource,
      configOnly,
    })
  );

  await railwayStep("environmentPatchCommitStaged", () =>
    commitStagedEnvironment(
      input.environmentId,
      configOnly
        ? "AI Factory worker config (no build)"
        : "AI Factory worker deploy",
      { skipDeploys: configOnly }
    )
  );

  await railwayStep("waitForServiceInstance", () =>
    waitForServiceInstance(input.serviceId, input.environmentId, {
      attempts: configOnly ? 15 : 30,
      delayMs: configOnly ? 2000 : 3000,
    })
  );
}

export function railwayConfig() {
  return {
    apiToken: Boolean(process.env.RAILWAY_API_TOKEN),
    projectId: process.env.RAILWAY_PROJECT_ID || "",
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID || "",
    templateServiceId: process.env.RAILWAY_CLI_TEMPLATE_SERVICE_ID || "",
    region: railwayCliRegion(),
  };
}

export function assertRailwayConfig() {
  const cfg = railwayConfig();
  const missing = [];
  if (!cfg.apiToken) missing.push("RAILWAY_API_TOKEN");
  if (!cfg.projectId) missing.push("RAILWAY_PROJECT_ID");
  if (!cfg.environmentId) missing.push("RAILWAY_ENVIRONMENT_ID");
  if (!cfg.templateServiceId) missing.push("RAILWAY_CLI_TEMPLATE_SERVICE_ID");
  if (missing.length) {
    throw new Error(`Railway não configurado: ${missing.join(", ")}`);
  }
  return cfg;
}

export function clientRailwayConfig() {
  return {
    apiToken: Boolean(process.env.RAILWAY_API_TOKEN),
    workspaceId: process.env.RAILWAY_WORKSPACE_ID || "",
  };
}

export function assertClientRailwayConfig() {
  const cfg = clientRailwayConfig();
  const missing = [];
  if (!cfg.apiToken) missing.push("RAILWAY_API_TOKEN");
  if (!cfg.workspaceId) missing.push("RAILWAY_WORKSPACE_ID");
  if (missing.length) {
    throw Object.assign(
      new Error(`Railway client deploy não configurado: ${missing.join(", ")}`),
      { status: 503, code: "railway_not_configured" }
    );
  }
  return cfg;
}

/**
 * @param {string} name
 * @param {string} workspaceId
 */
export async function createRailwayProject(name, workspaceId) {
  const data = await railwayGraphql(
    `mutation ProjectCreate($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name }
    }`,
    {
      input: {
        name,
        workspaceId,
      },
    }
  );
  const project = data?.projectCreate;
  if (!project?.id) {
    throw new Error("projectCreate não devolveu id");
  }
  return project;
}

/**
 * @param {string} projectId
 */
export async function getProjectDefaultEnvironment(projectId) {
  const data = await railwayGraphql(
    `query ProjectEnvironments($projectId: String!) {
      project(id: $projectId) {
        id
        environments {
          edges {
            node {
              id
              name
              isEphemeral
            }
          }
        }
      }
    }`,
    { projectId }
  );
  const edges = data?.project?.environments?.edges || [];
  const nodes = edges.map((e) => e?.node).filter(Boolean);
  const production =
    nodes.find((n) => String(n.name).toLowerCase() === "production") ||
    nodes.find((n) => !n.isEphemeral) ||
    nodes[0];
  if (!production?.id) {
    throw new Error("Ambiente Railway não encontrado no project");
  }
  return production;
}

/**
 * @param {string | undefined} rootDirectory
 * @returns {string|undefined}
 */
export function normalizeRootDirectory(rootDirectory) {
  const r = String(rootDirectory || "")
    .trim()
    .replace(/^\.\//, "");
  if (!r || r === ".") return undefined;
  return r;
}

/**
 * @param {object} config
 * @param {"source"|"config"} phase
 */
export function buildClientServicePatch(config, phase) {
  /** @type {Record<string, unknown>} */
  const patch = {};

  if (phase === "source") {
    if (config.isCreated === true) {
      patch.isCreated = true;
    }
    if (config.includeSource !== false && config.repo) {
      patch.source = {
        repo: config.repo,
        branch: config.branch || "main",
      };
    }
    return patch;
  }

  const vars = toStagedVariableMap(config.variables || {});
  if (Object.keys(vars).length > 0) {
    patch.variables = vars;
  }

  const root = normalizeRootDirectory(config.rootDirectory);
  if (root) {
    patch.rootDirectory = root;
  }

  if (config.dockerfilePath) {
    patch.build = {
      builder: "DOCKERFILE",
      dockerfilePath: String(config.dockerfilePath).replace(/^\.\//, ""),
    };
  }

  return patch;
}

async function stageEnvironmentServicePatch(
  environmentId,
  serviceId,
  servicePatch,
  merge = true
) {
  if (!servicePatch || Object.keys(servicePatch).length === 0) return;
  await railwayGraphql(
    `mutation StageClient($environmentId: String!, $input: EnvironmentConfig!, $merge: Boolean) {
      environmentStageChanges(
        environmentId: $environmentId
        input: $input
        merge: $merge
      ) { id }
    }`,
    {
      environmentId,
      merge,
      input: { services: { [serviceId]: servicePatch } },
    }
  );
}

/**
 * Configura repo + Dockerfile + env via staged changes (2 fases: source → build).
 * @param {{
 *   environmentId: string,
 *   serviceId: string,
 *   repo: string,
 *   branch?: string,
 *   variables?: Record<string, string>,
 *   rootDirectory?: string,
 *   dockerfilePath?: string,
 *   includeSource?: boolean,
 *   sourceCommitMessage?: string,
 *   configCommitMessage?: string,
 * }} input
 */
export async function applyClientServiceConfig(input) {
  const { environmentId, serviceId } = input;
  const branch = input.branch || "main";

  const { instance } = await railwayStep("fetchServiceInstance", () =>
    fetchServiceInstance(serviceId, environmentId)
  );

  const isCreated = needsServiceInstanceCreate(instance);
  const includeSource =
    input.includeSource ??
    !serviceInstanceHasRepo(instance, input.repo);

  const baseConfig = {
    repo: input.repo,
    branch,
    variables: input.variables || {},
    rootDirectory: input.rootDirectory,
    dockerfilePath: input.dockerfilePath || "Dockerfile",
    isCreated,
    includeSource,
  };

  if (isCreated || includeSource) {
    const sourcePatch = buildClientServicePatch(baseConfig, "source");
    if (Object.keys(sourcePatch).length > 0) {
      await railwayStep("environmentStageChanges(source)", () =>
        stageEnvironmentServicePatch(
          environmentId,
          serviceId,
          sourcePatch,
          true
        )
      );
      await railwayStep("environmentPatchCommitStaged(source)", () =>
        commitStagedEnvironment(
          environmentId,
          input.sourceCommitMessage || "DevForLess: connect deploy repo",
          { skipDeploys: true }
        )
      );
      await railwayStep("waitForServiceInstance(source)", () =>
        waitForServiceInstance(serviceId, environmentId, {
          attempts: 20,
          delayMs: 2000,
        })
      );
    }
  }

  const configPatch = buildClientServicePatch(baseConfig, "config");
  if (Object.keys(configPatch).length > 0) {
    await railwayStep("environmentStageChanges(config)", () =>
      stageEnvironmentServicePatch(
        environmentId,
        serviceId,
        configPatch,
        true
      )
    );
  }
}

/**
 * @deprecated Prefer applyClientServiceConfig — mantido para chamadas directas.
 */
export async function stageClientServiceConfig(environmentId, serviceId, config) {
  const sourcePatch = buildClientServicePatch(
    {
      ...config,
      isCreated: config.isCreated,
      includeSource: config.includeSource,
    },
    "source"
  );
  const configPatch = buildClientServicePatch(config, "config");
  const combined = { ...sourcePatch, ...configPatch };
  await stageEnvironmentServicePatch(environmentId, serviceId, combined, true);
}

/**
 * @param {string} environmentId
 * @param {string} serviceId
 */
export async function createRailwayPublicDomain(environmentId, serviceId) {
  const data = await railwayGraphql(
    `mutation DomainCreate($input: ServiceDomainCreateInput!) {
      serviceDomainCreate(input: $input) {
        id
        domain
      }
    }`,
    {
      input: {
        environmentId,
        serviceId,
        targetPort: null,
      },
    }
  );
  return data?.serviceDomainCreate ?? null;
}

/**
 * @param {{ projectId: string, environmentId: string, name?: string }} input
 */
export async function createPostgresService(input) {
  const name = input.name || "postgres";
  const svc = await createEmptyWorkerService({
    projectId: input.projectId,
    environmentId: input.environmentId,
    name,
  });
  return svc;
}

/**
 * Serviço Redis (plugin/template manual no Railway — placeholder para wiring de env).
 * @param {{ projectId: string, environmentId: string, name?: string }} input
 */
export async function createRedisService(input) {
  const name = input.name || "redis";
  const svc = await createEmptyWorkerService({
    projectId: input.projectId,
    environmentId: input.environmentId,
    name,
  });
  return svc;
}
