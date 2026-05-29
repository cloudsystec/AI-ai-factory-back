const RAILWAY_GRAPHQL_URL =
  process.env.RAILWAY_GRAPHQL_URL || "https://backboard.railway.com/graphql/v2";

/** Repo GitHub do worker CLI (1 repo para todos os tenants). ENV sobrescreve. */
export const DEFAULT_RAILWAY_CLI_REPO = "cloudsystec/AI-ai-factory-cli";
export const DEFAULT_RAILWAY_CLI_BRANCH = "main";
/** US West (California, USA) no Railway */
export const DEFAULT_RAILWAY_CLI_REGION = "us-west1";

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

/**
 * @param {unknown} service
 * @param {unknown} instance
 * @param {string} tenantId
 */
export function isWorkerServiceHealthy(service, instance, tenantId) {
  const svc = /** @type {{ id?: string, name?: string } | null} */ (service);
  if (!svc?.id || !instance) return false;
  if (!isWorkerServiceNameValid(svc.name, tenantId)) return false;
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
 * Cria serviço já ligado ao repo GitHub (cria ServiceInstance no ambiente).
 * Preferir a createEmptyService + staging para novos workers.
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

/**
 * @deprecated Usar createWorkerService. Mantido só para referência.
 * @param {{ projectId: string, name: string, environmentId: string }} input
 */
export async function createEmptyService(input) {
  return createWorkerService(input);
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
 *   region: string,
 *   variables: Record<string, string>,
 *   isCreated?: boolean,
 *   dockerfilePath?: string,
 *   includeSource?: boolean,
 * }} config
 */
export async function stageWorkerServiceConfig(environmentId, serviceId, config) {
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

  if (config.dockerfilePath) {
    servicePatch.build = {
      builder: "DOCKERFILE",
      dockerfilePath: config.dockerfilePath,
    };
  }

  servicePatch.deploy = {
    runtime: "V2",
    multiRegionConfig: {
      [config.region]: { numReplicas: 1 },
    },
  };

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
 */
export async function commitStagedEnvironment(environmentId, message) {
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
      skipDeploys: false,
    }
  );
}

/**
 * @param {{ projectId: string, environmentId: string, serviceId: string, mountPath: string, region: string }} input
 */
export async function createVolume(input) {
  const data = await railwayGraphql(
    `mutation VolumeCreate($input: VolumeCreateInput!) {
      volumeCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        mountPath: input.mountPath,
        region: input.region,
      },
    }
  );
  const vol = data?.volumeCreate;
  if (!vol?.id) throw new Error("volumeCreate não devolveu id");
  return vol;
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
 * Redeploy após volume; não falha se Railway ainda está "Applying changes".
 * O commit staged já dispara deploy inicial.
 * @param {string} environmentId
 * @param {string} serviceId
 */
export async function triggerWorkerRedeploy(environmentId, serviceId) {
  try {
    await waitForServiceInstance(serviceId, environmentId, {
      attempts: 10,
      delayMs: 3000,
    });
  } catch {
    return { skipped: true, reason: "instance_not_ready" };
  }

  try {
    const deploymentId = await deployServiceInstance(environmentId, serviceId);
    return { skipped: false, deploymentId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|processing|Problem processing/i.test(msg)) {
      return { skipped: true, reason: msg };
    }
    throw e;
  }
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
 * }} input
 */
export async function applyWorkerServiceConfig(input) {
  const repo = railwayCliRepo();
  const branch = railwayCliBranch();
  const region = railwayCliRegion();
  const dockerfilePath = process.env.RAILWAY_CLI_DOCKERFILE_PATH || "Dockerfile";

  const { instance } = await railwayStep("fetchServiceInstance", () =>
    fetchServiceInstance(input.serviceId, input.environmentId)
  );

  const createdFromRepo = input.createdFromRepo === true;
  const isCreated = createdFromRepo
    ? false
    : needsServiceInstanceCreate(instance);
  const includeSource = !serviceInstanceHasRepo(instance);

  await railwayStep("environmentStageChanges", () =>
    stageWorkerServiceConfig(input.environmentId, input.serviceId, {
      repo,
      branch,
      region,
      variables: input.variables,
      isCreated,
      dockerfilePath,
      includeSource,
    })
  );

  await railwayStep("environmentPatchCommitStaged", () =>
    commitStagedEnvironment(input.environmentId)
  );

  await railwayStep("waitForServiceInstance", () =>
    waitForServiceInstance(input.serviceId, input.environmentId)
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
