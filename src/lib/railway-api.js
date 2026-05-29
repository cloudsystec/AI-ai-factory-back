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
 * @param {{ projectId: string, name: string, environmentId: string }} input
 */
export async function createEmptyService(input) {
  const data = await railwayGraphql(
    `mutation ServiceCreate($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id name }
    }`,
    {
      input: {
        projectId: input.projectId,
        name: input.name,
        environmentId: input.environmentId,
      },
    }
  );
  const svc = data?.serviceCreate;
  if (!svc?.id) throw new Error("serviceCreate não devolveu id");
  return svc;
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
 * }} config
 */
export async function stageWorkerServiceConfig(environmentId, serviceId, config) {
  /** @type {Record<string, unknown>} */
  const servicePatch = {
    isCreated: config.isCreated === true,
    source: { repo: config.repo, branch: config.branch },
    variables: toStagedVariableMap(config.variables),
  };

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
  const isCreated = needsServiceInstanceCreate(instance);

  await railwayStep("environmentStageChanges", () =>
    stageWorkerServiceConfig(input.environmentId, input.serviceId, {
      repo,
      branch,
      region,
      variables: input.variables,
      isCreated,
      dockerfilePath,
    })
  );

  await railwayStep("environmentPatchCommitStaged", () =>
    commitStagedEnvironment(input.environmentId)
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
