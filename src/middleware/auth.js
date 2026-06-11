import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";
import { isPlatformAdminEmail } from "../lib/platform-admin-emails.js";
import {
  assertTenantNotBlockedForUser,
  getTenantBlockState,
  isTenantBlocked,
  tenantBlockedPayload,
} from "../services/tenant-block-service.js";
import { getCapabilitiesForUser, loadSessionUser } from "../services/user-service.js";
import { isUserLocked } from "../services/password-security-service.js";

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
    const userId = payload.userId;
    const email = payload.sub;
    const tenantId = payload.tenantId;

    if (userId) {
      const user = await loadSessionUser(userId);
      if (!user) {
        return res.status(401).json({ error: "Usuário inválido" });
      }
      if (isUserLocked(user)) {
        return res.status(403).json({
          error: "Conta bloqueada. Contate o auditor da sua empresa.",
          code: "account_locked",
        });
      }
      req.user = {
        id: user.id,
        email: user.email,
        tenantId: user.tenant_id,
        tenantName: user.tenant_name || "",
        role: user.role,
        tutorialPending: Boolean(user.tutorial_pending),
        passwordMustChange: Boolean(user.password_must_change),
      };
    } else if (email && tenantId) {
      req.user = {
        id: null,
        email,
        tenantId,
        role: payload.role || "auditor",
        passwordMustChange: false,
      };
    } else {
      return res.status(401).json({ error: "Token inválido" });
    }

    const caps = userId
      ? await getCapabilitiesForUser(userId)
      : null;
    if (caps) req.capabilities = caps;

    try {
      await assertTenantNotBlockedForUser(req.user.tenantId, req.user.email);
    } catch (e) {
      return res.status(e.status || 403).json({
        error: e.message,
        code: e.code || "tenant_blocked",
        blockReason: e.blockReason ?? undefined,
      });
    }

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
export function requirePasswordReady(req, res, next) {
  if (req.user?.passwordMustChange) {
    return res.status(403).json({
      error: "Deve alterar a senha antes de continuar",
      code: "password_change_required",
    });
  }
  next();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function attachCapabilities(req, res, next) {
  if (req.user?.id && !req.capabilities) {
    req.capabilities = await getCapabilitiesForUser(req.user.id);
  }
  next();
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export async function requireActivePlan(req, res, next) {
  const { rows } = await query(
    `SELECT id, name, plan_active_until, balance_usd, agent_slots_max,
            agent_slots_in_use, has_active_job, pool_credit_cycle_usd, plan_id,
            users_max, cotation, blocked_at, block_reason
     FROM tenants WHERE id = $1`,
    [req.user.tenantId]
  );
  const tenant = rows[0];
  if (!tenant) {
    return res.status(403).json({ code: "tenant_not_found" });
  }
  if (isTenantBlocked(tenant) && !isPlatformAdminEmail(req.user.email)) {
    return res.status(403).json(tenantBlockedPayload(tenant.block_reason));
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
export async function requireWorker(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: "Worker não autorizado" });
  }
  const tenantId = req.headers["x-tenant-id"];
  if (!tenantId || typeof tenantId !== "string") {
    return res.status(400).json({ error: "X-Tenant-Id obrigatório" });
  }
  try {
    const state = await getTenantBlockState(tenantId);
    if (!state) {
      return res.status(404).json({ error: "Tenant não encontrado" });
    }
    if (state.blocked) {
      return res.status(403).json(tenantBlockedPayload(state.blockReason));
    }
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
  req.workerTenantId = tenantId;
  next();
}
