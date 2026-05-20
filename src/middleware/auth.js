import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Token obrigatório" });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    req.user = {
      email: payload.sub,
      tenantId: payload.tenantId,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireActivePlan(req, res, next) {
  const { rows } = await query(
    `SELECT id, plan_active_until, balance_usd, agent_slots_max,
            agent_slots_in_use, has_active_job, pool_credit_cycle_usd, plan_id
     FROM tenants WHERE id = $1`,
    [req.user.tenantId]
  );
  const tenant = rows[0];
  if (!tenant) {
    return res.status(403).json({ code: "tenant_not_found" });
  }
  if (new Date(tenant.plan_active_until) < new Date()) {
    return res.status(403).json({ code: "plan_inactive" });
  }
  req.tenant = tenant;
  next();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireWorker(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: "Worker não autorizado" });
  }
  const tenantId = req.headers["x-tenant-id"];
  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "X-Tenant-Id obrigatório" });
  }
  req.workerTenantId = tenantId;
  next();
}
