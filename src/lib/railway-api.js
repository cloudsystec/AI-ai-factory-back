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
    throw new Error(
      body.errors.map((e) => e.message || String(e)).join("; ")
    );
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
 * @param {string} environmentId
 * @param {string} serviceId
 * @param {Record<string, unknown>} input
 */
export async function updateServiceInstance(environmentId, serviceId, input) {
  await railwayGraphql(
    `mutation ServiceInstanceUpdate(
      $environmentId: String!,
      $serviceId: String!,
      $input: ServiceInstanceUpdateInput!
    ) {
      serviceInstanceUpdate(
        environmentId: $environmentId,
        serviceId: $serviceId,
        input: $input
      )
    }`,
    { environmentId, serviceId, input }
  );
}

/**
 * @param {{ projectId: string, environmentId: string, serviceId: string, variables: Record<string, string> }} input
 */
export async function upsertServiceVariables(input) {
  await railwayGraphql(
    `mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }`,
    {
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        variables: input.variables,
        replace: false,
      },
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
 * Configuração do serviço CLI (defaults + ENV opcional).
 * @returns {Record<string, unknown>}
 */
export function buildInstanceInputFromEnv() {
  /** @type {Record<string, unknown>} */
  const input = {
    isCreated: true,
    region: railwayCliRegion(),
    source: {
      repo: railwayCliRepo(),
      branch: railwayCliBranch(),
    },
  };

  if (process.env.RAILWAY_CLI_ROOT_DIRECTORY) {
    input.rootDirectory = process.env.RAILWAY_CLI_ROOT_DIRECTORY;
  }
  if (process.env.RAILWAY_CLI_DOCKERFILE_PATH) {
    input.dockerfilePath = process.env.RAILWAY_CLI_DOCKERFILE_PATH;
    input.builder = "DOCKERFILE";
  }

  return input;
}

/**
 * Copia source/build do template para o input de serviceInstanceUpdate.
 * @param {{ instance: Record<string, unknown> | null, service: Record<string, unknown> | null }} template
 */
export function buildInstanceInputFromTemplate(template) {
  const fromEnv = buildInstanceInputFromEnv();
  if (fromEnv) return fromEnv;

  const inst = template.instance || {};
  /** @type {Record<string, unknown>} */
  const input = { isCreated: true };

  if (inst.region) input.region = inst.region;
  if (inst.builder) input.builder = inst.builder;
  if (inst.dockerfilePath) input.dockerfilePath = inst.dockerfilePath;
  if (inst.rootDirectory) input.rootDirectory = inst.rootDirectory;
  if (inst.startCommand) input.startCommand = inst.startCommand;

  const source = /** @type {Record<string, unknown>} */ (inst.source || {});
  if (source.image) {
    input.source = { image: source.image };
  } else if (source.repo) {
    input.source = {
      repo: source.repo,
      branch: process.env.RAILWAY_CLI_BRANCH || "main",
    };
  }

  if (!input.source && !input.dockerfilePath) {
    throw new Error(
      "Template CLI sem source reconhecível; configure RAILWAY_CLI_REPO ou RAILWAY_CLI_DOCKERFILE_PATH"
    );
  }

  return input;
}

/**
 * Resolve input de deploy: defaults fixos (repo CLI) — sem ler template via GraphQL.
 */
export async function resolveServiceInstanceInput() {
  const input = buildInstanceInputFromEnv();
  return {
    input,
    templateRegion: railwayCliRegion(),
  };
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
