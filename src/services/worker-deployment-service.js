import { query } from "../db/pool.js";
import { createLogger } from "../lib/logger.js";
import {
  assertRailwayConfig,
  applyWorkerServiceConfig,
  createEmptyWorkerService,
  createVolume,
  deleteRailwayService,
  fetchServiceInstance,
  isWorkerServiceConfigured,
  isWorkerServiceHealthy,
  isWorkerServiceNameValid,
  railwayStep,
  resolveServiceRegion,
  serviceInstanceHasRepo,
  triggerWorkerRedeploy,
  updateServiceName,
  workerServiceName,
  workerSkipsBuildOnProvision,
  workerSkipsVolumeOnProvision,
  workerTenantMountPath,
} from "../lib/railway-api.js";
import { buildTenantWorkerEnv } from "./tenant-worker-env-service.js";

const log = createLogger("worker-deploy");

const PROVISIONING_STALE_MS = 15 * 60 * 1000;

/**
 * @param {string} tenantId
 * @param {string | null} serviceId
 * @param {string} environmentId
 */
async function resolveWorkerServiceId(tenantId, serviceId, environmentId) {
  if (!serviceId) return null;

  const clearIds = async () => {
    await updateWorkerDeployment(tenantId, {
      railway_service_id: null,
      railway_volume_id: null,
    });
  };

  let service;
  let instance;
  try {
    ({ service, instance } = await fetchServiceInstance(
      serviceId,
      environmentId
    ));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not found|does not exist|invalid/i.test(msg)) throw e;
    log.warn("Serviço Railway ausente — limpar IDs", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
    });
    await clearIds();
    return null;
  }

  if (!service?.id) {
    await clearIds();
    return null;
  }

  if (isWorkerServiceNameValid(service.name, tenantId)) {
    return service.id;
  }

  log.warn("Serviço Railway com nome inválido — apagar e recriar", {
    tenantId: tenantId.slice(0, 8),
    serviceId,
    name: service.name,
    expectedName: workerServiceName(tenantId),
    hasRepo: serviceInstanceHasRepo(instance),
  });

  try {
    await railwayStep("serviceDelete", () => deleteRailwayService(serviceId));
  } catch (e) {
    log.warn("serviceDelete falhou — apague manualmente no Railway", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  await clearIds();
  return null;
}

/**
 * @param {string} tenantId
 */
export async function getWorkerDeployment(tenantId) {
  const { rows } = await query(
    `SELECT tenant_id, status, railway_service_id, railway_volume_id,
            last_error, provisioned_at, created_at, updated_at
     FROM tenant_worker_deployments WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * @param {string} tenantId
 */
export async function ensureWorkerDeploymentRow(tenantId) {
  await query(
    `INSERT INTO tenant_worker_deployments (tenant_id, status)
     VALUES ($1, 'pending')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId]
  );
}

/**
 * @param {string} tenantId
 * @param {Partial<{ status: string, railway_service_id: string, railway_volume_id: string, last_error: string | null, provisioned_at: Date | null }>} patch
 */
export async function updateWorkerDeployment(tenantId, patch) {
  const fields = [];
  const values = [tenantId];
  let i = 2;

  if (patch.status !== undefined) {
    fields.push(`status = $${i++}`);
    values.push(patch.status);
  }
  if (patch.railway_service_id !== undefined) {
    fields.push(`railway_service_id = $${i++}`);
    values.push(patch.railway_service_id);
  }
  if (patch.railway_volume_id !== undefined) {
    fields.push(`railway_volume_id = $${i++}`);
    values.push(patch.railway_volume_id);
  }
  if (patch.last_error !== undefined) {
    fields.push(`last_error = $${i++}`);
    values.push(patch.last_error);
  }
  if (patch.provisioned_at !== undefined) {
    fields.push(`provisioned_at = $${i++}`);
    values.push(patch.provisioned_at);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = now()");
  await query(
    `UPDATE tenant_worker_deployments SET ${fields.join(", ")} WHERE tenant_id = $1`,
    values
  );
}

/**
 * Fase 1: serviço + repo + variáveis (skipDeploys). Fase 2: Dockerfile + deploy (por defeito).
 * Sem região explícita nem volume (por defeito).
 * @param {string} tenantId
 * @param {{ force?: boolean }} [opts]
 */
export async function provisionWorkerForTenant(tenantId, opts = {}) {
  const force = opts.force === true;
  await ensureWorkerDeploymentRow(tenantId);
  const row = await getWorkerDeployment(tenantId);
  if (!row) {
    throw new Error("Deployment row missing after ensure");
  }

  if (
    !force &&
    row.status === "deployed" &&
    row.railway_service_id
  ) {
    log.info("Worker já configurado/provisionado", {
      tenantId: tenantId.slice(0, 8),
      status: row.status,
      serviceId: row.railway_service_id,
    });
    return { skipped: true, reason: "already_ready", deployment: row };
  }

  if (
    !force &&
    row.status === "provisioning" &&
    row.updated_at &&
    Date.now() - new Date(row.updated_at).getTime() < PROVISIONING_STALE_MS
  ) {
    return { skipped: true, reason: "in_progress", deployment: row };
  }

  const cfg = assertRailwayConfig();
  const skipBuild = workerSkipsBuildOnProvision();
  const skipVolume = workerSkipsVolumeOnProvision();

  await updateWorkerDeployment(tenantId, {
    status: "provisioning",
    last_error: null,
  });

  try {
    let serviceId = await resolveWorkerServiceId(
      tenantId,
      row.railway_service_id || null,
      cfg.environmentId
    );
    const isNewService = !serviceId;

    if (!serviceId) {
      const name = workerServiceName(tenantId);
      const created = await railwayStep("serviceCreate", () =>
        createEmptyWorkerService({
          projectId: cfg.projectId,
          environmentId: cfg.environmentId,
          name,
        })
      );
      serviceId = created.id;
      if (created.name !== name) {
        await railwayStep("serviceUpdate", () =>
          updateServiceName(serviceId, name)
        );
      }
      log.info("Serviço Railway vazio criado (sem build)", {
        tenantId: tenantId.slice(0, 8),
        serviceId,
        name,
      });
      await updateWorkerDeployment(tenantId, {
        railway_service_id: serviceId,
        railway_volume_id: null,
      });
    } else {
      log.info("Reutilizar serviço Railway existente", {
        tenantId: tenantId.slice(0, 8),
        serviceId,
      });
    }

    const env = await buildTenantWorkerEnv(tenantId);
    if (!env.BACK_URL || !env.WORKER_SECRET || !env.REDIS_URL) {
      throw new Error(
        "WORKER_BACK_URL (ou PUBLIC_BACK_URL), WORKER_SECRET e REDIS_URL/TENANT_REDIS_URL são obrigatórios para o worker"
      );
    }

    await applyWorkerServiceConfig({
      environmentId: cfg.environmentId,
      serviceId,
      variables: env,
      configOnly: true,
    });

    let volumeId = row.railway_volume_id || null;
    const mountPath = workerTenantMountPath(tenantId);

    if (!skipVolume && !volumeId) {
      const region = await railwayStep("resolveServiceRegion", () =>
        resolveServiceRegion(serviceId, cfg.environmentId)
      );
      const volume = await railwayStep("volumeCreate", () =>
        createVolume({
          projectId: cfg.projectId,
          environmentId: cfg.environmentId,
          serviceId,
          mountPath,
          region,
        })
      );
      volumeId = volume.id;
      await updateWorkerDeployment(tenantId, {
        railway_volume_id: volumeId,
      });
    }

    const { instance, service } = await fetchServiceInstance(
      serviceId,
      cfg.environmentId
    );
    const configured = isWorkerServiceConfigured(service, instance, tenantId);

    if (!configured) {
      throw new Error(
        "Config não aplicada — aguarde 'Applying changes' no Railway e reprovisione"
      );
    }

    let finalStatus = skipBuild ? "configured" : "provisioning";
    let buildPending = false;

    if (!skipBuild) {
      await applyWorkerServiceConfig({
        environmentId: cfg.environmentId,
        serviceId,
        variables: env,
        configOnly: false,
      });

      const redeploy = await railwayStep("serviceInstanceDeployV2", () =>
        triggerWorkerRedeploy(cfg.environmentId, serviceId)
      );

      const afterDeploy = await fetchServiceInstance(
        serviceId,
        cfg.environmentId
      );
      const healthy = isWorkerServiceHealthy(
        afterDeploy.service,
        afterDeploy.instance,
        tenantId
      );

      if (!healthy && !redeploy.skipped) {
        buildPending = true;
        finalStatus = "configured";
      } else if (healthy) {
        finalStatus = "deployed";
      } else {
        buildPending = true;
        finalStatus = "configured";
      }
    }

    await updateWorkerDeployment(tenantId, {
      status: finalStatus,
      last_error: buildPending
        ? "Build em curso no Railway — aguardar deployment"
        : null,
      provisioned_at: finalStatus === "deployed" ? new Date() : null,
    });

    log.info("Worker CLI provisionado no Railway", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
      volumeId: volumeId || null,
      mountPath: skipVolume ? null : mountPath,
      hasRepo: serviceInstanceHasRepo(instance),
      skipBuild,
      skipVolume,
      finalStatus,
    });

    return {
      skipped: false,
      skipBuild,
      skipVolume,
      buildPending,
      serviceId,
      volumeId: volumeId || null,
      mountPath: skipVolume ? null : mountPath,
      status: finalStatus,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateWorkerDeployment(tenantId, {
      status: "failed",
      last_error: message.slice(0, 2000),
    });
    log.error("Falha ao provisionar worker Railway", {
      tenantId: tenantId.slice(0, 8),
      err: message,
    });
    throw e;
  }
}

/**
 * Fase 2: Dockerfile + commit com deploy (build Docker).
 * @param {string} tenantId
 */
export async function deployWorkerForTenant(tenantId) {
  await ensureWorkerDeploymentRow(tenantId);
  const row = await getWorkerDeployment(tenantId);
  if (!row?.railway_service_id) {
    throw new Error("Provisione o worker antes de fazer build/deploy");
  }

  const cfg = assertRailwayConfig();
  const serviceId = row.railway_service_id;

  await updateWorkerDeployment(tenantId, {
    status: "provisioning",
    last_error: null,
  });

  try {
    const env = await buildTenantWorkerEnv(tenantId);

    await applyWorkerServiceConfig({
      environmentId: cfg.environmentId,
      serviceId,
      variables: env,
      configOnly: false,
    });

    const redeploy = await railwayStep("serviceInstanceDeployV2", () =>
      triggerWorkerRedeploy(cfg.environmentId, serviceId)
    );

    const { instance, service } = await fetchServiceInstance(
      serviceId,
      cfg.environmentId
    );
    const healthy = isWorkerServiceHealthy(service, instance, tenantId);

    if (!healthy && !redeploy.skipped) {
      throw new Error(
        "Build iniciado mas serviço ainda não está pronto — aguarde no Railway"
      );
    }

    await updateWorkerDeployment(tenantId, {
      status: healthy ? "deployed" : "configured",
      last_error: healthy
        ? null
        : "Build em curso no Railway — aguardar deployment",
      provisioned_at: healthy ? new Date() : row.provisioned_at,
    });

    log.info("Worker CLI build/deploy disparado", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
      healthy,
      redeploySkipped: redeploy.skipped,
    });

    return {
      serviceId,
      deploymentId: redeploy.deploymentId,
      status: healthy ? "deployed" : "configured",
      buildPending: !healthy,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await updateWorkerDeployment(tenantId, {
      status: "failed",
      last_error: message.slice(0, 2000),
    });
    throw e;
  }
}

/**
 * @param {string} tenantId
 */
export function enqueueWorkerProvision(tenantId) {
  void ensureWorkerDeploymentRow(tenantId)
    .then(() => provisionWorkerForTenant(tenantId))
    .catch((e) => {
      log.error("enqueueWorkerProvision falhou", {
        tenantId: tenantId.slice(0, 8),
        err: e instanceof Error ? e.message : String(e),
      });
    });
}

/**
 * @param {string} tenantId
 */
export async function retryWorkerProvision(tenantId) {
  await ensureWorkerDeploymentRow(tenantId);
  await updateWorkerDeployment(tenantId, {
    status: "pending",
    last_error: null,
  });
  return provisionWorkerForTenant(tenantId, { force: true });
}
