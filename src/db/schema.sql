-- Nova AI billing schema.
-- Runs automatically on server boot (see src/db/index.js: migrate()).
-- Safe to run repeatedly — every statement is idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  google_id     TEXT UNIQUE,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per user. tier defaults to 'free' the moment a user first logs in,
-- even before any Stripe interaction — this is what makes Free-tier limits
-- enforceable instead of just aspirational.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                     TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  status                   TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled | incomplete
  current_period_end       TIMESTAMPTZ,
  addons                   JSONB NOT NULL DEFAULT '[]',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- One row per user per calendar month. Incremented after every successful
-- chat message / image generation; checked before the request is allowed.
CREATE TABLE IF NOT EXISTS usage_counters (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  messages_used   INTEGER NOT NULL DEFAULT 0,
  images_used     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_counters(user_id, period_start);

-- ── Conversation history ─────────────────────────────────────
-- UUIDs here (unlike the SERIAL ids above) since these may end up in
-- exports or shared links later; users/subscriptions stay internal-only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New conversation',
  starred     BOOLEAN NOT NULL DEFAULT false,
  archived    BOOLEAN NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL, -- 'user' | 'assistant'
  provider        TEXT,
  model           TEXT,
  content         TEXT NOT NULL,
  tokens          INTEGER,
  latency_ms      INTEGER,
  cost_usd        NUMERIC(10, 6),
  attachments     JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_title_search ON conversations USING gin (to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_messages_content_search ON messages USING gin (to_tsvector('english', content));
