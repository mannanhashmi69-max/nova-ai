// ─── Nova AI subscription tiers ─────────────────────────────
// Single source of truth for pricing, limits, and feature flags.
// Every place in the app that needs to know "what does this
// plan include" reads from here — never hardcode a limit elsewhere.
//
// To launch a tier for real: create a matching Product + Price in
// the Stripe Dashboard, then put its Price ID in the env var named
// below (see .env.example). Until a tier has a stripePriceId, it
// simply won't be offered at checkout — everything else about it
// (limits, feature flags) still works for manual/comped accounts.
//
// "limit: null" means unlimited on that dimension.

const TIERS = {
  free: {
    id: 'free',
    name: 'Free',
    price: 0,
    stripePriceId: null, // free tier never goes through Stripe Checkout
    selfServe: true,
    status: 'active',
    limits: { messagesPerMonth: 100, imagesPerMonth: 5, historyDays: 7, teamMembers: 1 },
    features: {
      knowledgeBase: false, websiteChatbot: false, automation: false,
      apiAccess: false, whiteLabel: false, sso: false, onPrem: false,
    },
  },

  starter: {
    id: 'starter',
    name: 'Starter',
    price: 1,
    stripePriceId: (process.env.STRIPE_PRICE_STARTER || '').trim() || null,
    selfServe: true,
    status: 'active',
    limits: { messagesPerMonth: 1000, imagesPerMonth: 25, historyDays: null, teamMembers: 1 },
    features: {
      knowledgeBase: false, websiteChatbot: false, automation: false,
      apiAccess: false, whiteLabel: false, sso: false, onPrem: false,
    },
  },

  creator: {
    id: 'creator',
    name: 'Creator',
    price: 10,
    stripePriceId: (process.env.STRIPE_PRICE_CREATOR || '').trim() || null,
    selfServe: true,
    status: 'active',
    // The pricing doc says "unlimited chats (fair use)". Unlimited-with-no-ceiling
    // is a real cost risk on metered LLM APIs, so this is a generous fair-use
    // ceiling, not a promise from the original doc. Tune it once you know your
    // real per-message cost.
    limits: { messagesPerMonth: 10000, imagesPerMonth: 200, historyDays: null, teamMembers: 1 },
    features: {
      knowledgeBase: false, websiteChatbot: false, automation: false,
      apiAccess: false, whiteLabel: false, sso: false, onPrem: false,
    },
  },

  professional: {
    id: 'professional',
    name: 'Professional',
    price: 25,
    stripePriceId: (process.env.STRIPE_PRICE_PROFESSIONAL || '').trim() || null,
    selfServe: true,
    status: 'active',
    limits: { messagesPerMonth: 10000, imagesPerMonth: 200, historyDays: null, teamMembers: 1 },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: false,
      apiAccess: false, whiteLabel: true, sso: false, onPrem: false,
    },
  },

  business: {
    id: 'business',
    name: 'Business Automation',
    price: 50,
    stripePriceId: (process.env.STRIPE_PRICE_BUSINESS || '').trim() || null,
    selfServe: true,
    status: 'active',
    limits: { messagesPerMonth: 25000, imagesPerMonth: 500, historyDays: null, teamMembers: 5 },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: true,
      apiAccess: true, whiteLabel: true, sso: false, onPrem: false,
    },
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 100,
    stripePriceId: (process.env.STRIPE_PRICE_ENTERPRISE || '').trim() || null,
    selfServe: true,
    status: 'active',
    limits: { messagesPerMonth: null, imagesPerMonth: null, historyDays: null, teamMembers: null },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: true,
      apiAccess: true, whiteLabel: true, sso: false, onPrem: false,
    },
  },

  // ── The doc frames these three as "Future Enterprise Plans," not launch
  // tiers. They're modeled here so the roadmap is machine-readable, but
  // selfServe:false means /api/billing/checkout refuses them — route
  // interest to a "contact us" flow instead of a Stripe Checkout link,
  // since things like on-prem deployment aren't self-serve purchases.
  agency: {
    id: 'agency',
    name: 'Agency',
    price: 299,
    stripePriceId: (process.env.STRIPE_PRICE_AGENCY || '').trim() || null,
    selfServe: false,
    status: 'future',
    limits: { messagesPerMonth: null, imagesPerMonth: null, historyDays: null, teamMembers: null },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: true, apiAccess: true,
      whiteLabel: true, sso: false, onPrem: false, multiClientWorkspaces: true,
    },
  },

  businessPro: {
    id: 'businessPro',
    name: 'Business Pro',
    price: 999,
    stripePriceId: null,
    selfServe: false,
    status: 'future',
    limits: { messagesPerMonth: null, imagesPerMonth: null, historyDays: null, teamMembers: null },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: true, apiAccess: true,
      whiteLabel: true, sso: true, onPrem: false, auditLogs: true,
    },
  },

  enterpriseCustom: {
    id: 'enterpriseCustom',
    name: 'Enterprise Custom',
    price: null, // "starting at $2,000" — quote-based, not a fixed Stripe price
    stripePriceId: null,
    selfServe: false,
    status: 'future',
    limits: { messagesPerMonth: null, imagesPerMonth: null, historyDays: null, teamMembers: null },
    features: {
      knowledgeBase: true, websiteChatbot: true, automation: true, apiAccess: true,
      whiteLabel: true, sso: true, onPrem: true, auditLogs: true, dedicatedInfra: true,
    },
  },
};

const ADDONS = {
  extraAssistant:      { id: 'extraAssistant',      name: 'Extra AI assistant',       price: 5,  stripePriceId: (process.env.STRIPE_PRICE_ADDON_ASSISTANT || '').trim() || null },
  extraTeamMember:     { id: 'extraTeamMember',      name: 'Additional team member',   price: 3,  stripePriceId: (process.env.STRIPE_PRICE_ADDON_TEAM || '').trim() || null },
  extraKnowledgeBase:  { id: 'extraKnowledgeBase',   name: 'Extra knowledge base',     price: 10, stripePriceId: (process.env.STRIPE_PRICE_ADDON_KB || '').trim() || null },
  premiumModels:       { id: 'premiumModels',        name: 'Premium AI models',        price: 15, stripePriceId: (process.env.STRIPE_PRICE_ADDON_PREMIUM || '').trim() || null },
  advancedAnalytics:   { id: 'advancedAnalytics',    name: 'Advanced analytics',       price: 10, stripePriceId: (process.env.STRIPE_PRICE_ADDON_ANALYTICS || '').trim() || null },
  voiceAI:             { id: 'voiceAI',              name: 'Voice AI',                 price: 20, stripePriceId: (process.env.STRIPE_PRICE_ADDON_VOICE || '').trim() || null },
  whatsapp:            { id: 'whatsapp',             name: 'WhatsApp integration',     price: 25, stripePriceId: (process.env.STRIPE_PRICE_ADDON_WHATSAPP || '').trim() || null },
  customBranding:      { id: 'customBranding',       name: 'Custom branding',          price: 15, stripePriceId: (process.env.STRIPE_PRICE_ADDON_BRANDING || '').trim() || null },
  extraAutomationRuns: { id: 'extraAutomationRuns',  name: 'Extra automation runs',    price: 10, stripePriceId: (process.env.STRIPE_PRICE_ADDON_RUNS || '').trim() || null },
};

function getTier(tierId) {
  return TIERS[tierId] || TIERS.free;
}

function listPublicTiers() {
  return Object.values(TIERS);
}

function listSelfServeTiers() {
  return Object.values(TIERS).filter((t) => t.selfServe);
}

module.exports = { TIERS, ADDONS, getTier, listPublicTiers, listSelfServeTiers };
