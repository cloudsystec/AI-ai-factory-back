/**
 * Extração de dados de eventos Stripe (Checkout Session, Invoice).
 * @see https://docs.stripe.com/payments/checkout/name-collection
 * collected_information.business_name e customer_details.business_name
 */

/**
 * @param {unknown} value
 */
function nonEmptyString(value) {
  if (value == null) return "";
  const s = String(value).trim();
  return s;
}

/**
 * Nome da empresa no checkout (Payment Link com name_collection.business).
 * @param {import('stripe').Stripe.Checkout.Session} session
 */
export function companyNameFromCheckoutSession(session) {
  const collected = /** @type {{ business_name?: string } | null | undefined} */ (
    session.collected_information
  );
  return (
    nonEmptyString(collected?.business_name) ||
    nonEmptyString(session.customer_details?.business_name) ||
    nonEmptyString(session.metadata?.company_name) ||
    ""
  );
}

/**
 * @param {import('stripe').Stripe.Invoice} invoice
 * @param {{ business_name?: string; name?: string } | null | undefined} [customer]
 */
export function companyNameFromInvoice(invoice, customer) {
  return (
    nonEmptyString(invoice.metadata?.company_name) ||
    nonEmptyString(customer?.business_name) ||
    nonEmptyString(customer?.name) ||
    nonEmptyString(invoice.customer_name) ||
    ""
  );
}

/**
 * @param {import('stripe').Stripe.Event} event
 * @param {{ business_name?: string; name?: string } | null | undefined} [stripeCustomer]
 */
export function companyNameFromStripeEvent(event, stripeCustomer) {
  if (event.type === "checkout.session.completed") {
    const session = /** @type {import('stripe').Stripe.Checkout.Session} */ (
      event.data.object
    );
    return companyNameFromCheckoutSession(session);
  }
  if (event.type === "invoice.paid") {
    const invoice = /** @type {import('stripe').Stripe.Invoice} */ (event.data.object);
    return companyNameFromInvoice(invoice, stripeCustomer);
  }
  return "";
}
