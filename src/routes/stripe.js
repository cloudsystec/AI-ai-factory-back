import { Router } from "express";
import { query } from "../db/pool.js";
import { hashPassword } from "../lib/password.js";
import { upsertTenant } from "../services/tenant-service.js";

export const stripeRouter = Router();

stripeRouter.post("/webhooks/stripe", async (req, res) => {
  const event = req.body;
  const eventId = event?.id;
  if (!eventId) {
    return res.status(400).json({ error: "event.id obrigatório" });
  }

  const { rows: seen } = await query(
    "SELECT 1 FROM stripe_events WHERE event_id = $1",
    [eventId]
  );
  if (seen.length > 0) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "invoice.paid"
    ) {
      const email =
        event.data?.object?.customer_email ||
        event.data?.object?.customer_details?.email ||
        event.data?.object?.metadata?.email;
      if (email) {
        const tenant = await upsertTenant({
          email,
          planId: event.data?.object?.metadata?.plan_id || "starter",
        });
        const tempPassword =
          event.data?.object?.metadata?.temp_password ||
          process.env.STRIPE_DEFAULT_USER_PASSWORD;
        const passwordHash = tempPassword
          ? hashPassword(String(tempPassword))
          : null;
        await query(
          `INSERT INTO users (tenant_id, email, role, password_hash)
           VALUES ($1, $2, 'auditor', $3)
           ON CONFLICT (tenant_id, email) DO NOTHING`,
          [tenant.id, tenant.email, passwordHash]
        );
      }
    }
    await query("INSERT INTO stripe_events (event_id) VALUES ($1)", [eventId]);
    res.json({ received: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "webhook failed" });
  }
});
