const express = require('express');
const billing = require('./stripe');
const { runSelfTest } = require('./selftest');
const { listPublicTiers, ADDONS } = require('../config/tiers');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to manage your plan.' });
}

// GET /api/billing/selftest — read-only config + evidence check for the
// Phase-1 checklist. Optionally locked with SELFTEST_TOKEN so it isn't
// wide open once the app is public; leave that env var unset while you're
// still setting things up.
router.get('/selftest', async (req, res) => {
  const token = (process.env.SELFTEST_TOKEN || '').trim();
  if (token && req.query.token !== token) {
    return res.status(401).json({ error: 'Pass ?token=<SELFTEST_TOKEN> to use this endpoint.' });
  }
  try {
    res.json(await runSelfTest());
  } catch (err) {
    res.status(500).json({ error: 'Self-test failed to run', detail: err.message });
  }
});

// GET /api/billing/tiers — public, powers the pricing page.
router.get('/tiers', (req, res) => {
  res.json({ tiers: listPublicTiers(), addons: Object.values(ADDONS) });
});

// POST /api/billing/checkout  { tierId, addonIds? } — returns a Stripe Checkout URL to redirect to.
router.post('/checkout', requireAuth, async (req, res) => {
  if (!billing.isEnabled()) return res.status(503).json({ error: 'Billing isn\u2019t configured on this server yet.' });
  const { tierId, addonIds } = req.body || {};
  if (!tierId) return res.status(400).json({ error: 'tierId is required' });

  try {
    const session = await billing.createCheckoutSession({
      user: req.dbUser,
      tierId,
      addonIds: Array.isArray(addonIds) ? addonIds : [],
      successUrl: `${process.env.BASE_URL}/?checkout=success`,
      cancelUrl: `${process.env.BASE_URL}/?checkout=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/billing/portal — returns a Stripe customer portal URL (upgrade/downgrade/cancel/invoices).
router.post('/portal', requireAuth, async (req, res) => {
  if (!billing.isEnabled()) return res.status(503).json({ error: 'Billing isn\u2019t configured on this server yet.' });
  try {
    const session = await billing.createPortalSession({
      user: req.dbUser,
      returnUrl: `${process.env.BASE_URL}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Stripe webhooks need the RAW request body to verify the signature, but
// app.use(express.json()) in src/index.js has already parsed everything by
// the time a normal router would see it. So this route is registered
// directly on the app, before express.json(), by mountWebhook() below —
// it is deliberately NOT part of `router`.
function mountWebhook(app) {
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!billing.isEnabled()) return res.status(503).end();

    const signature = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      event = billing.stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      console.warn('[WARN] Stripe webhook signature check failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await billing.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error('[ERR]  Stripe webhook handling failed:', err.message);
      res.status(500).json({ error: 'Webhook handling failed' });
    }
  });
}

module.exports = { router, mountWebhook };
