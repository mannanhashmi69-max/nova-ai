const db = require('../db');
const { getTier } = require('../config/tiers');

// Mounted globally, right after passport.session(). For logged-in users (once
// DATABASE_URL is set) this attaches:
//   req.dbUser       — the persisted user row (id, email, ...)
//   req.subscription — their subscriptions row (tier, status, stripe ids...)
//   req.tier         — the resolved tier object from config/tiers.js
// Guests, and every request when DATABASE_URL isn't set, pass through
// untouched — the app behaves exactly as it did before this file existed.
async function attachUser(req, res, next) {
  try {
    if (db.isEnabled() && req.isAuthenticated && req.isAuthenticated() && req.user) {
      const googleId    = req.user.id;
      const email        = req.user.email;
      const displayName  = req.user.name;
      if (googleId && email) {
        const dbUser = await db.upsertUserByGoogle({ googleId, email, displayName });
        const subscription = await db.getSubscription(dbUser.id);
        req.dbUser = dbUser;
        req.subscription = subscription;
        req.tier = getTier(subscription?.tier || 'free');
      }
    }
  } catch (err) {
    // Never let a billing hiccup take down chat for everyone else.
    console.warn('[WARN] attachUser failed, continuing as guest:', err.message);
  }
  next();
}

// kind: 'messages' | 'images'. Use as route middleware:
//   app.post('/api/chat', chatLimiter, usageGate('messages'), handler)
function usageGate(kind) {
  const limitField = kind === 'images' ? 'imagesPerMonth' : 'messagesPerMonth';

  return async (req, res, next) => {
    // No database, or the request isn't tied to an account (guest) → the
    // existing per-IP rate limiter (chatLimiter/imageLimiter) is still the
    // only gate, same as before this file existed.
    if (!db.isEnabled() || !req.dbUser || !req.tier) return next();

    const limit = req.tier.limits[limitField];
    if (limit == null) return next(); // unlimited on this tier

    try {
      const usage = await db.getUsage(req.dbUser.id);
      const used = kind === 'images' ? usage.imagesUsed : usage.messagesUsed;

      if (used >= limit) {
        return res.status(402).json({
          error: `You've reached your ${req.tier.name} plan's limit of ${limit} ${kind === 'images' ? 'images' : 'messages'}/month.`,
          code: 'USAGE_LIMIT_REACHED',
          tier: req.tier.id,
          limit,
          used,
        });
      }

      // Only count it once we know the request actually succeeded.
      res.on('finish', () => {
        if (res.statusCode < 400) {
          db.incrementUsage(req.dbUser.id, kind).catch((err) =>
            console.warn('[WARN] incrementUsage failed:', err.message)
          );
        }
      });
      next();
    } catch (err) {
      // Fail OPEN: a usage-tracking bug should never be why a paying
      // customer can't send a message.
      console.warn('[WARN] usageGate failed open:', err.message);
      next();
    }
  };
}

module.exports = { attachUser, usageGate };
