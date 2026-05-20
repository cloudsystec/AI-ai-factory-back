import { Router } from "express";
import jwt from "jsonwebtoken";
import { query } from "../db/pool.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "")
    .trim()
    .toLowerCase();
  const password = req.body?.password;

  if (!email || typeof password !== "string") {
    return res.status(400).json({ error: "email e password obrigatórios" });
  }

  const master = process.env.MASTER_PASSWORD;
  if (!master || password !== master) {
    return res.status(401).json({ error: "Credenciais inválidas" });
  }

  const { rows } = await query(
    `SELECT u.email, u.tenant_id, t.plan_active_until
     FROM users u
     JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [email]
  );

  if (!rows[0]) {
    return res.status(401).json({ error: "Utilizador não encontrado" });
  }

  if (new Date(rows[0].plan_active_until) < new Date()) {
    return res.status(403).json({ code: "plan_inactive" });
  }

  const token = jwt.sign(
    { sub: rows[0].email, tenantId: rows[0].tenant_id },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "7d" }
  );

  res.json({
    token,
    email: rows[0].email,
    tenantId: rows[0].tenant_id,
  });
});
