import { query } from "../db/pool.js";
import { createLogger } from "../lib/logger.js";
import {
  assertRailwayConfig,
  applyWorkerServiceConfig,
  createVolume,
  createWorkerService,
  deleteRailwayService,
  fetchServiceInstance,
  isWorkerServiceHealthy,
  isWorkerServiceNameValid,
  railwayCliRegion,
  railwayStep,
  serviceInstanceHasRepo,
  triggerWorkerRedeploy,
  updateServiceName,
  waitForServiceInstance,
  workerServiceName,
} from "../lib/railway-api.js";
import { buildTenantWorkerEnv } from "./tenant-worker-env-service.js";

const log = createLogger("worker-deploy");

const PROVISIONING_STALE_MS = 15 * 60 * 1000;

/**
 * Serviço ausente, nome corrompido (cli-uuid-uuid…) ou sem repo → apagar e recriar.
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
    log.warn("Serviço Railway ausente — limpar IDs", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
    });
    await clearIds();
    return null;
  }

  const nameOk = isWorkerServiceNameValid(service.name, tenantId);
  const hasRepo = serviceInstanceHasRepo(instance);

  if (nameOk && hasRepo) return service.id;

  log.warn("Serviço Railway inválido — apagar e recriar", {
    tenantId: tenantId.slice(0, 8),
    serviceId,
    name: service.name,
    expectedName: workerServiceName(tenantId),
    hasRepo,
  });

  try {
    await railwayStep("serviceDelete", () => deleteRailwayService(serviceId));
  } catch (e) {
    log.warn("serviceDelete falhou — apague manualmente no Railway se persistir", {
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
    log.info("Worker já provisionado", {
      tenantId: tenantId.slice(0, 8),
      serviceId: row.railway_service_id,
    });
    return { skipped: true, reason: "already_deployed", deployment: row };
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
    const createdFromRepo = !serviceId;

    if (!serviceId) {
      const name = workerServiceName(tenantId);
      const created = await railwayStep("serviceCreate", () =>
        createWorkerService({
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
      await railwayStep("waitForServiceInstance", () =>
        waitForServiceInstance(serviceId, cfg.environmentId, {
          attempts: 15,
          delayMs: 2000,
        })
      );
      log.info("Serviço Railway criado a partir do repo CLI", {
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
        "PUBLIC_BACK_URL, WORKER_SECRET e REDIS_URL/TENANT_REDIS_URL são obrigatórios para o worker"
      );
    }

    await applyWorkerServiceConfig({
      environmentId: cfg.environmentId,
      serviceId,
      variables: env,
      createdFromRepo,
    });

    let volumeId = createdFromRepo ? null : row.railway_volume_id || null;
    const mountPath = `/app/data/tenants/${tenantId}`;

    if (!volumeId) {
      const region = cfg.region || railwayCliRegion();

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

    const redeploy = await railwayStep("serviceInstanceDeployV2", () =>
      triggerWorkerRedeploy(cfg.environmentId, serviceId)
    );
    if (redeploy.skipped) {
      log.warn("Redeploy ignorado (Railway ainda a aplicar changes)", {
        tenantId: tenantId.slice(0, 8),
        reason: redeploy.reason,
      });
    }

    const { instance, service } = await fetchServiceInstance(
      serviceId,
      cfg.environmentId
    );
    const healthy = isWorkerServiceHealthy(service, instance, tenantId);

    if (!healthy && !redeploy.skipped) {
      const missingRepo = instance && !serviceInstanceHasRepo(instance);
      throw new Error(
        missingRepo
          ? "Serviço sem repo GitHub ligado — reprovisione após deploy do back"
          : "Config aplicada mas ServiceInstance ainda não visível — aguarde 'Applying changes' no Railway"
      );
    }

    await updateWorkerDeployment(tenantId, {
      status: healthy ? "deployed" : "provisioning",
      last_error: healthy
        ? null
        : "Railway a aplicar changes ou repo em falta — aguardar 2 min e reprovisionar",
      provisioned_at: healthy ? new Date() : null,
    });

    if (!healthy) {
      log.warn("Provisionamento parcial — aguardar Railway ou repo", {
        tenantId: tenantId.slice(0, 8),
        serviceId,
        hasRepo: serviceInstanceHasRepo(instance),
        serviceName: service?.name,
      });
      return {
        skipped: false,
        pendingRailway: true,
        serviceId,
        volumeId,
        mountPath,
      };
    }

    log.info("Worker CLI provisionado no Railway", {
      tenantId: tenantId.slice(0, 8),
      serviceId,
      volumeId,
      mountPath,
    });

    return {
      skipped: false,
      serviceId,
      volumeId,
      mountPath,
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
