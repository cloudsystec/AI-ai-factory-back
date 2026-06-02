import { requireAuth } from "./auth.js";
import {
  getPlatformAdminEmails,
  isPlatformAdminEmail,
} from "../lib/platform-admin-emails.js";

export { isPlatformAdminEmail, getPlatformAdminEmails };

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requirePlatformAdmin(req, res, next) {
  requireAuth(req, res, () => {
    const allow = getPlatformAdminEmails();
    if (allow.length === 0 && process.env.ALLOW_DEV_ROUTES === "true") {
      return next();
    }
    const email = req.user?.email?.toLowerCase();
    if (!email || !allow.includes(email)) {
      return res.status(403).json({ error: "Acesso admin negado" });
    }
    next();
  });
}
