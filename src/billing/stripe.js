// ─── Stripe integration ───────────────────────────────────────
// Same defensive pattern as the rest of the app: no STRIPE_SECRET_KEY
// set → isEnabled() is false and billing routes respond 503 instead
// of crashing the server.

const Stripe = require('stripe');
const { TIERS, ADDONS, getTier } = require('../config/tiers');
const db = require('../db');

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const isEnabled = () => !!stripe;

async function ensureStripeCustomer(user) {
  const existing = await db.getSubscription(user.id);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { novaUserId: String(user.id) },
  });

  await db.setSubscriptionFromStripe({
    userId: user.id,
    tier: existing?.tier || 'free',
    stripeCustomerId: customer.id,
    stripeSubscriptionId: existing?.stripe_subscription_id || null,
    status: existing?.status || 'active',
    currentPeriodEnd: existing?.current_period_end || null,
  });

  return customer.id;
}

async function createCheckoutSession({ user, tierId, addonIds = [], successUrl, cancelUrl }) {
  const tier = getTier(tierId);
  if (!tier.selfServe) {
    throw new Error(`${tier.name} is a contact-sales plan, not self-serve checkout yet.`);
  }
  if (!tier.stripePriceId) {
    throw new Error(`${tier.name} has no Stripe Price ID configured yet — see .env.example.`);
  }

  const customerId = await ensureStripeCustomer(user);
  const lineItems = [{ price: tier.stripePriceId, quantity: 1 }];

  for (const addonId of addonIds) {
    const addon = ADDONS[addonId];
    if (addon?.stripePriceId) lineItems.push({ price: addon.stripePriceId, quantity: 1 });
  }

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { novaUserId: String(user.id), tierId },
    subscription_data: { metadata: { novaUserId: String(user.id), tierId } },
  });
}

async function createPortalSession({ user, returnUrl }) {
  const customerId = await ensureStripeCustomer(user);
  return stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
}

function priceIdToTierId(priceId) {
  for (const tier of Object.values(TIERS)) {
    if (tier.stripePriceId && tier.stripePriceId === priceId) return tier.id;
  }
  return null;
}

// Called by the webhook route in billing/routes.js after signature verification.
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = Number(session.metadata?.novaUserId);
      const tierId = session.metadata?.tierId;
      if (!userId || !tierId || !session.subscription) break;

      const subscription = await stripe.subscriptions.retrieve(session.subscription);
      await db.setSubscriptionFromStripe({
        userId,
        tier: tierId,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      });
      break;
    }

    // Covers upgrades, downgrades, renewals, cancellations, and payment failures —
    // Stripe is the source of truth, this just mirrors it into our own tables.
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const user = await db.findUserByStripeCustomerId(subscription.customer);
      if (!user) break;

      const priceId = subscription.items?.data?.[0]?.price?.id;
      const isCanceled = event.type === 'customer.subscription.deleted';
      const tierId = isCanceled ? 'free' : (priceIdToTierId(priceId) || 'free');

      await db.setSubscriptionFromStripe({
        userId: user.id,
        tier: tierId,
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        status: isCanceled ? 'canceled' : subscription.status,
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      });
      break;
    }

    default:
      // Unhandled event types are fine to ignore — Stripe sends many we don't need.
      break;
  }
}

module.exports = { stripe, isEnabled, createCheckoutSession, createPortalSession, handleWebhookEvent };
