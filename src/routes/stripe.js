/**
 * Stripe webhook — cadastre no Dashboard:
 *   POST https://<api>/webhooks/stripe
 * Eventos: checkout.session.completed, invoice.paid
 *
 * Payment Links (subscription): metadata `plan_id` = starter | team | scale | business
 * Nome da empresa: collected_information.business_name no Checkout Session
 */
import crypto from "node:crypto";
import { Router } from "express";
import Stripe from "stripe";
import { query } from "../db/pool.js";
import { hashPassword } from "../lib/password.js";
import { createLogger } from "../lib/logger.js";
import {
  companyNameFromCheckoutSession,
  companyNameFromInvoice,
} from "../lib/stripe-webhook-helpers.js";
import { upsertTenant } from "../services/tenant-service.js";

const log = createLogger("stripe");

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/** @type {Record<string, string>} */
function priceIdToPlanMap() {
  return {
    [process.env.STRIPE_PRICE_STARTER || ""]: "starter",
    [process.env.STRIPE_PRICE_TEAM || ""]: "team",
    [process.env.STRIPE_PRICE_SCALE || ""]: "scale",
    [process.env.STRIPE_PRICE_BUSINESS || ""]: "business",
  };
}

/**
 * @param {string | undefined} priceId
 */
function planIdFromPriceId(priceId) {
  if (!priceId) return null;
  const map = priceIdToPlanMap();
  return map[priceId] || null;
}

/**
 * @param {Record<string, string> | null | undefined} metadata
 */
function planIdFromMetadata(metadata) {
  const raw = metadata?.plan_id || metadata?.plan;
  if (!raw) return null;
  const id = String(raw).trim().toLowerCase();
  if (["starter", "team", "scale", "business", "enterprise"].includes(id)) {
    return id === "enterprise" ? "business" : id;
  }
  return null;
}

/**
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
function planIdFromSession(session) {
  return (
    planIdFromMetadata(session.metadata) ||
    planIdFromPriceId(session.metadata?.price_id) ||
    "starter"
  );
}

/**
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
function emailFromSession(session) {
  return (
    session.customer_details?.email ||
    session.customer_email ||
    session.metadata?.email ||
    null
  );
}

/**
 * @param {import('stripe').Stripe.Invoice} invoice
 */
function emailFromInvoice(invoice) {
  return (
    invoice.customer_email ||
    invoice.metadata?.email ||
    null
  );
}

function resolveTempPassword() {
  const fromEnv = process.env.STRIPE_DEFAULT_USER_PASSWORD;
  if (fromEnv) return String(fromEnv);
  const generated = crypto.randomBytes(12).toString("base64url");
  if (process.env.NODE_ENV !== "production") {
    log.info("Senha temporária gerada para auditor (dev)", { password: generated });
  }
  return generated;
}

/**
 * @param {string} tenantId
 * @param {string} email
 */
async function ensureAuditorUser(tenantId, email, { updatePasswordIfMissing = true } = {}) {
  const tempPassword = resolveTempPassword();
  const passwordHash = hashPassword(tempPassword);
  if (updatePasswordIfMissing) {
    await query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, 'auditor', $3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         role = EXCLUDED.role,
         password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)`,
      [tenantId, email, passwordHash]
    );
  } else {
    await query(
      `INSERT INTO users (tenant_id, email, role, password_hash)
       VALUES ($1, $2, 'auditor', $3)
       ON CONFLICT (tenant_id, email) DO NOTHING`,
      [tenantId, email, passwordHash]
    );
  }
}

/**
 * @param {import('stripe').Stripe.Checkout.Session} session
 * @returns {Promise<string | null>} tenant id
 */
async function provisionFromCheckoutSession(session) {
  const email = emailFromSession(session);
  if (!email) {
    log.warn("checkout.session.completed sem email", { sessionId: session.id });
    return null;
  }
  const planId = planIdFromSession(session);
  const companyName = companyNameFromCheckoutSession(session);
  const tenant = await upsertTenant({
    email,
    name: companyName,
    planId,
  });
  await ensureAuditorUser(tenant.id, tenant.email);
  log.info("Tenant provisionado via Stripe", {
    tenantId: tenant.id,
    email: tenant.email,
    planId,
    companyName: companyName || undefined,
  });
  return tenant.id;
}

/**
 * @param {import('stripe').Stripe.Invoice} invoice
 * @returns {Promise<string | null>} tenant id
 */
async function provisionFromInvoicePaid(invoice) {
  const email = emailFromInvoice(invoice);
  if (!email) {
    log.warn("invoice.paid sem email", { invoiceId: invoice.id });
    return null;
  }

  let stripeCustomer = null;
  const customerId =
    typeof invoice.customer === "string"
      ? invoice.customer
      : invoice.customer?.id;
  if (stripeClient && customerId) {
    try {
      stripeCustomer = await stripeClient.customers.retrieve(customerId);
    } catch (e) {
      log.warn("Não foi possível carregar customer Stripe", {
        customerId,
        message: e.message,
      });
    }
  }

  const companyName = companyNameFromInvoice(invoice, stripeCustomer);

  let subscriptionMetadata = null;
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;
  if (stripeClient && subscriptionId) {
    try {
      const sub = await stripeClient.subscriptions.retrieve(subscriptionId);
      subscriptionMetadata = sub.metadata;
    } catch (e) {
      log.warn("Não foi possível carregar subscription Stripe", {
        subscriptionId,
        message: e.message,
      });
    }
  }

  const planId =
    planIdFromMetadata(invoice.metadata) ||
    planIdFromMetadata(subscriptionMetadata) ||
    planIdFromPriceId(invoice.lines?.data?.[0]?.price?.id) ||
    "starter";

  const tenant = await upsertTenant({
    email,
    name: companyName,
    planId,
  });
  await ensureAuditorUser(tenant.id, tenant.email, { updatePasswordIfMissing: false });
  log.info("Tenant atualizado via invoice.paid", {
    tenantId: tenant.id,
    email: tenant.email,
    planId,
    companyName: companyName || undefined,
  });
  return tenant.id;
}

/**
 * @param {import('stripe').Stripe.Event} event
 * @returns {Promise<string | null>} tenant id quando provisionado
 */
async function handleStripeEvent(event) {
  if (event.type === "checkout.session.completed") {
    const session = /** @type {import('stripe').Stripe.Checkout.Session} */ (
      event.data.object
    );
    return provisionFromCheckoutSession(session);
  }

  if (event.type === "invoice.paid") {
    const invoice = /** @type {import('stripe').Stripe.Invoice} */ (event.data.object);
    return provisionFromInvoicePaid(invoice);
  }

  return null;
}

/**
 * @param {import('stripe').Stripe.Event} event
 * @param {string | null} tenantId
 */
async function recordStripeEvent(event, tenantId) {
  await query(
    `INSERT INTO stripe_events (event_id, event_type, payload, tenant_id)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [event.id, event.type, JSON.stringify(event), tenantId]
  );
}

/**
 * POST /webhooks/stripe — body raw (Buffer)
 */
export async function handleStripeWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET não configurado" });
  }

  const signature = req.headers["stripe-signature"];
  if (!signature || !Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: "Assinatura ou body inválidos" });
  }

  /** @type {import('stripe').Stripe.Event} */
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (e) {
    log.warn("Webhook Stripe: assinatura inválida", { message: e.message });
    return res.status(400).json({ error: "Invalid signature" });
  }

  log.info("Webhook Stripe recebido", {
    eventId: event.id,
    type: event.type,
    livemode: event.livemode,
  });

  const eventId = event.id;
  const { rows: seen } = await query(
    "SELECT 1 FROM stripe_events WHERE event_id = $1",
    [eventId]
  );
  if (seen.length > 0) {
    return res.json({ received: true, duplicate: true });
  }

  try {
    const handled =
      event.type === "checkout.session.completed" || event.type === "invoice.paid";
    const tenantId = handled ? await handleStripeEvent(event) : null;
    await recordStripeEvent(event, tenantId);
    res.json({ received: true, tenantId: tenantId || undefined });
  } catch (e) {
    log.error("Webhook Stripe falhou", { err: e.message, eventId, type: event.type });
    res.status(500).json({ error: "webhook failed" });
  }
}

export const stripeRouter = Router();
