// ─── Database layer ──────────────────────────────────────────
// Everything here is optional at boot: if DATABASE_URL isn't set,
// isEnabled() returns false and every other function becomes a
// harmless no-op. That keeps the app bootable exactly as before
// for anyone who hasn't added Postgres yet — same defensive
// pattern the rest of this codebase already uses for GROQ_KEY /
// GEMINI_KEY (see ENV.* checks in src/index.js).

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Most managed Postgres (Railway included) sits behind a proxy with a
      // self-signed cert — this matches how Railway's own docs configure `pg`.
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

const isEnabled = () => !!pool;

async function migrate() {
  if (!pool) {
    console.warn('[WARN] DATABASE_URL not set — billing/usage tracking disabled, app runs as before.');
    return;
  }
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[OK]   Database schema ready');
}

// ── Users ────────────────────────────────────────────────────

async function upsertUserByGoogle({ googleId, email, displayName }) {
  if (!pool || !googleId || !email) return null;
  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
     RETURNING *`,
    [googleId, email, displayName || null]
  );
  const user = rows[0];
  // Every user gets a 'free' subscription row the moment they exist, so
  // limits are enforceable from message #1 — not just after they pay.
  await pool.query(
    `INSERT INTO subscriptions (user_id, tier) VALUES ($1, 'free') ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );
  return user;
}

async function getUserById(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findUserByStripeCustomerId(customerId) {
  if (!pool || !customerId) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM users u JOIN subscriptions s ON s.user_id = u.id WHERE s.stripe_customer_id = $1`,
    [customerId]
  );
  return rows[0] || null;
}

// ── Subscriptions ────────────────────────────────────────────

async function getSubscription(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function setSubscriptionFromStripe({ userId, tier, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET
       tier                    = EXCLUDED.tier,
       stripe_customer_id      = EXCLUDED.stripe_customer_id,
       stripe_subscription_id  = EXCLUDED.stripe_subscription_id,
       status                  = EXCLUDED.status,
       current_period_end      = EXCLUDED.current_period_end,
       updated_at              = now()
     RETURNING *`,
    [userId, tier, stripeCustomerId || null, stripeSubscriptionId || null, status || 'active', currentPeriodEnd || null]
  );
  return rows[0];
}

// ── Usage ────────────────────────────────────────────────────

function currentPeriodStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getUsage(userId) {
  if (!pool) return { messagesUsed: 0, imagesUsed: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM usage_counters WHERE user_id = $1 AND period_start = $2`,
    [userId, currentPeriodStart()]
  );
  if (!rows[0]) return { messagesUsed: 0, imagesUsed: 0 };
  return { messagesUsed: rows[0].messages_used, imagesUsed: rows[0].images_used };
}

async function incrementUsage(userId, kind) {
  if (!pool) return;
  const column = kind === 'images' ? 'images_used' : 'messages_used';
  await pool.query(
    `INSERT INTO usage_counters (user_id, period_start, ${column})
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, period_start) DO UPDATE SET ${column} = usage_counters.${column} + 1`,
    [userId, currentPeriodStart()]
  );
}

// ── Self-test helpers ────────────────────────────────────────
// Real checks against the live connection — not just "is the env var set."

async function ping() {
  if (!pool) throw new Error('DATABASE_URL not set');
  await pool.query('SELECT 1');
  return true;
}

async function schemaLoaded() {
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [['users', 'subscriptions', 'usage_counters']]
  );
  return rows.length === 3;
}

// Historical evidence a real checkout → webhook → DB-update loop has ever
// completed. This is read from our own records, not inferred or simulated —
// it can say "yes, N times" but only ever that, never "probably."
async function getBillingEvidence() {
  if (!pool) return { linkedCount: 0, paidCount: 0, anySubscriptionLinked: false, anyPaidTier: false };
  const { rows: linked } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM subscriptions WHERE stripe_subscription_id IS NOT NULL`
  );
  const { rows: paid } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM subscriptions WHERE tier <> 'free'`
  );
  return {
    linkedCount: linked[0].count,
    paidCount: paid[0].count,
    anySubscriptionLinked: linked[0].count > 0,
    anyPaidTier: paid[0].count > 0,
  };
}

module.exports = {
  isEnabled,
  migrate,
  upsertUserByGoogle,
  getUserById,
  findUserByStripeCustomerId,
  getSubscription,
  setSubscriptionFromStripe,
  getUsage,
  incrementUsage,
  ping,
  schemaLoaded,
  getBillingEvidence,
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  softDeleteConversation,
  addMessage,
  listMessages,
  searchConversations,
};

// ── Conversations ─────────────────────────────────────────────

async function createConversation(userId, title) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *`,
    [userId, title || 'New conversation']
  );
  return rows[0];
}

async function listConversations(userId, { limit = 50, cursor = null, archived = false } = {}) {
  if (!pool) return { items: [], nextCursor: null };
  const params = [userId, archived, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND updated_at < $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id, title, starred, archived, created_at, updated_at
     FROM conversations
     WHERE user_id = $1 AND archived = $2 AND deleted_at IS NULL ${cursorClause}
     ORDER BY updated_at DESC
     LIMIT $3`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].updated_at : null };
}

async function getConversation(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT * FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  return rows[0] || null;
}

async function updateConversation(id, userId, { title, starred, archived }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE conversations SET
       title = COALESCE($3, title),
       starred = COALESCE($4, starred),
       archived = COALESCE($5, archived),
       updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [id, userId, title ?? null, starred ?? null, archived ?? null]
  );
  return rows[0] || null;
}

// Soft delete only — never a real DELETE, per spec.
async function softDeleteConversation(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
    [id, userId]
  );
  return rows[0] || null;
}

// ── Messages ─────────────────────────────────────────────────

async function addMessage(conversationId, { role, provider = null, model = null, content, tokens = null, latencyMs = null, costUsd = null, attachments = [] }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, role, provider, model, content, tokens, latency_ms, cost_usd, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [conversationId, role, provider, model, content, tokens, latencyMs, costUsd, JSON.stringify(attachments || [])]
  );
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  return rows[0];
}

async function listMessages(conversationId, { limit = 50, cursor = null } = {}) {
  if (!pool) return { items: [], nextCursor: null };
  const params = [conversationId, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND created_at > $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ${cursorClause} ORDER BY created_at ASC LIMIT $2`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].created_at : null };
}

// Partial-match search across conversation titles and message content,
// scoped to the requesting user's own conversations only.
async function searchConversations(userId, query, { limit = 50, cursor = null } = {}) {
  if (!pool || !query) return { items: [], nextCursor: null };
  const like = `%${query}%`;
  const params = [userId, like, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND c.updated_at < $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id, c.title, c.starred, c.archived, c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.user_id = $1 AND c.deleted_at IS NULL
       AND (c.title ILIKE $2 OR m.content ILIKE $2) ${cursorClause}
     ORDER BY c.updated_at DESC
     LIMIT $3`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].updated_at : null };
}
