// ─── Billing self-test ────────────────────────────────────────
// Read-only. Every field is either a live check (we actually pinged the
// database / called Stripe) or real historical evidence (we queried our
// own records for proof something already happened) — never a guess and
// never "probably." Anything that can only be confirmed by a human
// clicking through a real checkout says so explicitly instead of
// defaulting to true or false.

const db = require('../db');
const billing = require('./stripe');
const { listSelfServeTiers } = require('../config/tiers');

async function runSelfTest() {
  const result = {
    environment: {
      stripe_secret_key: !!process.env.STRIPE_SECRET_KEY,
      stripe_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      database_url: !!process.env.DATABASE_URL,
    },
    database: { connected: false, schema_loaded: false },
    stripe: { api_reachable: false, account_id: null },
    billing: {
      checkout_route_configured: false,
      missing_price_env_vars: [],
      portal_configured: false,
      webhook_secret_loaded: false,
    },
    verification: {
      checkout_completed: { status: false, note: 'No completed Stripe Checkout session found in your last 5 sessions.' },
      webhook_received: { status: false, note: 'No subscription in Postgres carries a real Stripe subscription ID yet.' },
      subscription_updated: { status: false, note: 'No user has moved off the free tier in the database yet.' },
      usage_gate_verified: { status: false, note: 'Not automatable — hit your Free-tier limit and confirm a 402, then upgrade and confirm it lifts.' },
    },
  };

  // ── Database: an actual query, not just "is the var set" ──
  if (db.isEnabled()) {
    try {
      await db.ping();
      result.database.connected = true;
      result.database.schema_loaded = await db.schemaLoaded();
    } catch (err) {
      result.database.error = err.message;
    }
  }

  // ── Stripe: an actual API call, so a bad/revoked key shows up here ──
  if (billing.isEnabled()) {
    try {
      const account = await billing.stripe.accounts.retrieve();
      result.stripe.api_reachable = true;
      result.stripe.account_id = account.id;
    } catch (err) {
      result.stripe.error = err.message;
    }

    // Customer Portal needs a "configuration" set up in the Stripe Dashboard
    // (Settings → Billing → Customer portal) or sessions.create() throws —
    // an easy step to miss that a route existing in code won't catch.
    try {
      const configs = await billing.stripe.billingPortal.configurations.list({ limit: 1 });
      result.billing.portal_configured = configs.data.length > 0;
    } catch (err) {
      result.billing.portal_error = err.message;
    }
  }

  // ── Price IDs: which self-serve tiers can actually check out today ──
  const missing = listSelfServeTiers()
    .filter((t) => t.price > 0 && !t.stripePriceId)
    .map((t) => t.id);
  result.billing.missing_price_env_vars = missing;
  result.billing.checkout_route_configured = billing.isEnabled() && missing.length === 0;
  result.billing.webhook_secret_loaded = !!(process.env.STRIPE_WEBHOOK_SECRET || '').trim().startsWith('whsec_');

  // ── Verification: real evidence pulled from Stripe + our own database ──
  if (billing.isEnabled()) {
    try {
      const sessions = await billing.stripe.checkout.sessions.list({ limit: 5 });
      const completed = sessions.data.filter((s) => s.status === 'complete');
      if (completed.length > 0) {
        result.verification.checkout_completed = {
          status: true,
          note: `${completed.length} completed session(s) found in your last 5 Stripe Checkout sessions.`,
        };
      }
    } catch { /* leave as false — Stripe unreachable is already reported above */ }
  }

  if (db.isEnabled() && result.database.connected) {
    try {
      const evidence = await db.getBillingEvidence();
      if (evidence.anySubscriptionLinked) {
        result.verification.webhook_received = {
          status: true,
          note: `${evidence.linkedCount} subscription row(s) carry a real Stripe subscription ID — the webhook has written to Postgres at least once.`,
        };
      }
      if (evidence.anyPaidTier) {
        result.verification.subscription_updated = {
          status: true,
          note: `${evidence.paidCount} account(s) are on a paid tier in the database right now.`,
        };
      }
    } catch { /* leave as false */ }
  }

  return result;
}

module.exports = { runSelfTest };
