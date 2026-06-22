const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const https      = require('https');
const dns        = require('dns');
const rateLimit  = require('express-rate-limit');
const session    = require('express-session');
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

dns.setDefaultResultOrder('ipv4first');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── ENV (must be defined first — session/passport/limiters use it) ──
const ENV = {
  GROQ_KEY:             (process.env.GROQ_API_KEY          || '').trim(),
  GEMINI_KEY:           (process.env.GEMINI_API_KEY         || '').trim(),
  GOOGLE_CLIENT_ID:     (process.env.GOOGLE_CLIENT_ID       || '').trim(),
  GOOGLE_CLIENT_SECRET: (process.env.GOOGLE_CLIENT_SECRET   || '').trim(),
  SESSION_SECRET:       (process.env.SESSION_SECRET         || ''),
  BASE_URL:             (process.env.BASE_URL               || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:5000')),
  NODE_ENV:             (process.env.NODE_ENV               || 'development'),
};

(function validateEnv() {
  const checks = [
    { val: ENV.GROQ_KEY,             prefix: 'gsk_',   label: 'Groq',              key: 'GROQ_API_KEY'          },
    { val: ENV.GEMINI_KEY,           prefix: 'AIzaSy', label: 'Gemini',            key: 'GEMINI_API_KEY'        },
    { val: ENV.GOOGLE_CLIENT_ID,     prefix: '',       label: 'Google OAuth ID',   key: 'GOOGLE_CLIENT_ID'      },
    { val: ENV.GOOGLE_CLIENT_SECRET, prefix: '',       label: 'Google OAuth Secret', key: 'GOOGLE_CLIENT_SECRET'},
    { val: ENV.SESSION_SECRET,       prefix: '',       label: 'Session Secret',    key: 'SESSION_SECRET'        },
  ];
  for (const { val, prefix, label, key } of checks) {
    if (!val)                                   console.warn(`[WARN] ${key} not set — ${label} disabled`);
    else if (prefix && !val.startsWith(prefix)) console.error(`[ERR]  ${key} looks wrong — expected prefix "${prefix}"`);
    else                                        console.log(`[OK]   ${key} loaded (${label})`);
  }
  if (!ENV.SESSION_SECRET) {
    console.error('[ERR]  SESSION_SECRET missing — sessions will be insecure. Add to Railway Variables!');
  }
  console.log('[OK]   Image: Pollinations flux-schnell → flux → picsum fallback');
})();

const app = express();

// FIX: trust proxy so Railway IP-based rate limiting works correctly
// Without this, all requests look like they come from the same proxy IP
app.set('trust proxy', 1);

// FIX: restrict CORS to your own domain in production, allow all in dev
app.use(cors({
  origin: ENV.NODE_ENV === 'production'
    ? [ENV.BASE_URL, 'https://nova-ai-production-5ad8.up.railway.app']
    : '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Session ───────────────────────────────────────────────
app.use(session({
  secret: ENV.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: ENV.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// ─── Rate limiters (Fix #4 — ChatGPT) ─────────────────────
// Chat: 30 requests / minute per IP — protects Groq/Gemini quotas
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '⚠️ Too many messages. Please wait a moment.' }
});
// Image: 10 requests / minute — image gen is slower & more expensive
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '⚠️ Too many image requests. Please wait a moment.' }
});
// General API: 120 requests / minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: '⚠️ Too many requests.' }
});
app.use('/api/', apiLimiter);

const ipv4Agent = new https.Agent({ family: 4 });

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

class RateLimitError extends Error {
  constructor(provider) {
    super(`${provider} rate limit reached`);
    this.name     = 'RateLimitError';
    this.provider = provider;
  }
}

async function safeJson(res) {
  const text = await res.text();
  try   { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response: ${text.slice(0, 120)}`); }
}

// ─── In-memory user store (replace with DB later) ──────────
const users = new Map();   // googleId → { id, name, email, picture }

// ─── Passport: Google OAuth ────────────────────────────────
if (ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     ENV.GOOGLE_CLIENT_ID,
      clientSecret: ENV.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${ENV.BASE_URL}/auth/google/callback`,
    },
    (_accessToken, _refreshToken, profile, done) => {
      const user = {
        id:      profile.id,
        name:    profile.displayName,
        email:   profile.emails?.[0]?.value || '',
        picture: profile.photos?.[0]?.value || '',
      };
      users.set(profile.id, user);
      return done(null, user);
    }
  ));
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => done(null, users.get(id) || false));
}

// ─── Auth routes ───────────────────────────────────────────
// GET /auth/google        → redirect to Google consent screen
// GET /auth/google/callback → Google returns here after login
// GET /api/me             → frontend polls this to check login state
// GET /logout             → clear session

app.get('/auth/google', (req, res, next) => {
  if (!ENV.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google login not configured on this server.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/?auth=success')
);

app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ loggedIn: true, user: req.user });
  }
  res.json({ loggedIn: false });
});

app.get('/logout', (req, res) => {
  req.logout?.(() => {});
  req.session?.destroy?.();
  res.redirect('/');
});

// ─── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    providers: {
      groq:         !!ENV.GROQ_KEY,
      gemini:       !!ENV.GEMINI_KEY,
      pollinations: true,
      victor:       true,
      googleAuth:   !!(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET),
    },
    timestamp: new Date().toISOString()
  });
});

// ─── Models list (for model-picker UI) ──────────────────────
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'auto',         name: 'Auto',              description: 'Fastest reliable answer — tries providers in order',          available: true },
      { id: 'victor',       name: 'Victor',            description: 'Multi-agent: routes → drafts → validates → refines',           available: true },
      { id: 'groq',         name: 'Groq · Llama 3.3',  description: 'Fast and high quality',                                        available: !!ENV.GROQ_KEY },
      { id: 'gemini',       name: 'Gemini 2.0',        description: "Google's flash model",                                         available: !!ENV.GEMINI_KEY },
      { id: 'pollinations', name: 'Pollinations',      description: 'Free, always available',                                       available: true }
    ]
  });
});

// ─── Guest login ───────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const token = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ success: true, token, username: 'Guest' });
});

// ─── Image generation ──────────────────────────────────────
// Strategy:
//   1. Pollinations flux-schnell  (fast model, ~5s)
//   2. Pollinations flux          (standard model, ~15s)
//   3. Pollinations default       (bare endpoint fallback)
//   4. picsum.photos              (always works — random photo, never fails)
//
// Key fixes vs old version:
//   - flux-schnell first (5x faster than flux)
//   - Per-attempt AbortController so one slow attempt doesn't block next
//   - Buffer fully read before checking content-type (Railway streaming quirk)
//   - Picsum guaranteed fallback so users NEVER see a blank error

app.post('/api/image', imageLimiter, async (req, res) => {
  const { prompt, size = '512' } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const seed = Math.floor(Math.random() * 999999);
  const enc  = encodeURIComponent(prompt.slice(0, 500));
  const sz   = parseInt(size, 10) || 512;

  // Attempt each Pollinations variant with individual timeouts
  const pollinationsAttempts = [
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&model=flux-schnell&nologo=true&seed=${seed}`, label: 'flux-schnell', timeout: 25000 },
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&model=flux&nologo=true&seed=${seed}`,         label: 'flux',         timeout: 45000 },
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&nologo=true&seed=${seed}`,                   label: 'default',      timeout: 45000 },
  ];

  for (const attempt of pollinationsAttempts) {
    try {
      console.log(`🎨 Trying Pollinations ${attempt.label}…`);
      const response = await fetchWithTimeout(
        attempt.url,
        { agent: ipv4Agent, headers: { 'Accept': 'image/*' } },
        attempt.timeout
      );

      if (!response.ok) {
        console.warn(`   ✗ HTTP ${response.status}`);
        continue;
      }

      const ct = response.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        console.warn(`   ✗ Wrong content-type: ${ct}`);
        continue;
      }

      // Read full buffer — Railway can close stream early if we peek headers only
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) {
        console.warn(`   ✗ Buffer too small (${buffer.length} bytes) — likely an error page`);
        continue;
      }

      const ext = ct.includes('png') ? 'png' : 'jpeg';
      console.log(`✅ Pollinations ${attempt.label} succeeded (${buffer.length} bytes)`);
      return res.json({
        imageUrl: `data:image/${ext};base64,${buffer.toString('base64')}`,
        source:   `pollinations-${attempt.label}`
      });
    } catch (err) {
      console.warn(`   ✗ Pollinations ${attempt.label} error: ${err.message}`);
    }
  }

  // ── Guaranteed fallback: picsum.photos ────────────────────
  // Always returns a real photo. Not AI-generated but ALWAYS works.
  // Better than showing the user an error.
  console.log('⚠️  All Pollinations attempts failed — using picsum fallback');
  try {
    const picsumUrl = `https://picsum.photos/seed/${seed}/${sz}/${sz}`;
    const picsumRes = await fetchWithTimeout(picsumUrl, { agent: ipv4Agent }, 10000);
    if (picsumRes.ok) {
      const buf = Buffer.from(await picsumRes.arrayBuffer());
      console.log('✅ Picsum fallback succeeded');
      return res.json({
        imageUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
        source:   'picsum',
        note:     '⚠️ AI generation is slow right now — showing a stock photo instead. Try again in a minute for AI art.'
      });
    }
  } catch (err) {
    console.warn(`   ✗ Picsum fallback error: ${err.message}`);
  }

  return res.status(503).json({
    error: '🖼️ Image generation is temporarily unavailable on this server. Please try again in 1–2 minutes.'
  });
});

// ─── Video (disabled) ──────────────────────────────────────
app.post('/api/generate-video', (_req, res) => res.status(503).json({
  error: '🎬 Video generation requires a paid API. Use the Image tab for free AI visuals.'
}));
app.get('/api/video-status/:jobId', (_req, res) => res.status(410).json({ error: 'Disabled.' }));

// ─── Chat providers ────────────────────────────────────────
function fixGeminiHistory(historyOnly) {
  const turns  = [];
  let lastRole = null;
  for (const msg of historyOnly) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    if (role === lastRole) {
      turns[turns.length - 1].parts[0].text += '\n' + msg.content;
    } else {
      turns.push({ role, parts: [{ text: msg.content }] });
      lastRole = role;
    }
  }
  return turns;
}

const providerCooldowns = new Map();

const AI_PROVIDERS = [
  {
    name:      'Groq',
    available: () => !!ENV.GROQ_KEY,
    call:      async (messages, signal) => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 2048, temperature: 0.7 }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Groq');
      if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      // FIX (Bug #4): optional chaining — Groq can return empty choices on edge cases
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned empty response');
      return text.trim();
    }
  },
  {
    name:      'Gemini',
    available: () => !!ENV.GEMINI_KEY,
    call:      async (messages, signal) => {
      const systemMsg  = messages.find(m => m.role === 'system')?.content || '';
      const fixedTurns = fixGeminiHistory(messages.filter(m => m.role !== 'system').slice(0, -1));
      const lastMsg    = messages[messages.length - 1];
      fixedTurns.push({ role: 'user', parts: [{ text: lastMsg.content }] });
      const body = { contents: fixedTurns, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } };
      if (systemMsg.trim()) body.system_instruction = { parts: [{ text: systemMsg }] };
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${ENV.GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Gemini');
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned empty or blocked response');
      return text.trim();
    }
  },
  {
    name:      'Pollinations',
    available: () => true,
    call:      async (messages, signal) => {
      const res = await fetchWithTimeout(
        'https://text.pollinations.ai/openai',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages }), signal },
        25000
      );
      if (res.status === 429) throw new RateLimitError('Pollinations');
      if (!res.ok) throw new Error(`Pollinations ${res.status}`);
      const data = await safeJson(res);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Pollinations returned empty response');
      return text.trim();
    }
  }
];

async function getAIReply(messages, preferred, signal) {
  const now = Date.now();
  let providers = AI_PROVIDERS.filter(p => {
    if (!p.available()) return false;
    const cooldown = providerCooldowns.get(p.name);
    if (cooldown && now < cooldown) { console.log(`[WAIT] ${p.name} in cooldown`); return false; }
    return true;
  });

  if (preferred && preferred !== 'auto' && preferred !== 'victor') {
    const idx = providers.findIndex(p => p.name.toLowerCase() === preferred.toLowerCase());
    if (idx > 0) providers = [providers[idx], ...providers.slice(0, idx), ...providers.slice(idx + 1)];
  }

  if (providers.length === 0) throw new Error('All AI providers unavailable or in cooldown');
  let lastError = null;
  for (const provider of providers) {
    // Don't start a new provider call if the client already disconnected
    if (signal?.aborted) throw new Error('Client disconnected');
    try {
      console.log(`[TRY]  ${provider.name}...`);
      const reply = await provider.call(messages, signal);
      console.log(`[OK]   ${provider.name} succeeded`);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      if (err.name === 'AbortError') throw err; // propagate disconnect immediately
      console.warn(`[WARN] ${provider.name} failed: ${err.message}`);
      if (err instanceof RateLimitError) providerCooldowns.set(provider.name, Date.now() + 60_000);
      lastError = err;
    }
  }
  throw new Error('All providers failed. Last error: ' + lastError?.message);
}

// ─── Victor: multi-agent reasoning pipeline ─────────────────
// Not a separate AI — it's a 5-stage process built ON TOP of
// the providers above: Router (classify intent) → Processor
// (draft via real AI) → Validator (score the draft) →
// Optimizer (re-prompt AI to improve, up to 2x if needed) →
// Executor (return final text). This is what makes "Victor"
// a genuinely different model option, not a relabeled Groq call.

function victorRoute(userMessage) {
  const lower = userMessage.toLowerCase();
  let intent = 'general';
  if (/code|function|bug|debug|script|programming/.test(lower)) intent = 'code';
  else if (/write|essay|article|story|email|draft/.test(lower)) intent = 'writing';
  else if (/analy[sz]e|compare|pros and cons|evaluate|research/.test(lower)) intent = 'analysis';
  return { agent: 'Router', intent };
}

function victorValidate(text) {
  const checks = [
    { name: 'length',    passed: text.trim().length >= 20 },
    { name: 'no-refusal', passed: !/^(error|sorry, i (can't|cannot))/i.test(text.trim()) },
    { name: 'clean',     passed: !text.includes('undefined') && !text.includes('[object Object]') }
  ];
  const score = Math.round((checks.filter(c => c.passed).length / checks.length) * 100);
  return { agent: 'Validator', score, isValid: score >= 70 };
}

async function victorOptimize(messages, draft, signal) {
  const refineMessages = [
    ...messages,
    { role: 'assistant', content: draft },
    { role: 'user', content: 'Improve and tighten your previous answer — fix gaps, keep it accurate and well-structured. Reply with only the improved answer, nothing else.' }
  ];
  return getAIReply(refineMessages, 'auto', signal);
}

async function runVictorPipeline(messages, signal) {
  const userMessage = messages[messages.length - 1].content;
  const route = victorRoute(userMessage);

  let { reply: text, provider } = await getAIReply(messages, 'auto', signal);
  let validation = victorValidate(text);
  let attempts = 0;

  while (!validation.isValid && attempts < 2) {
    if (signal?.aborted) break;
    attempts++;
    try {
      const opt = await victorOptimize(messages, text, signal);
      text = opt.reply;
      provider = opt.provider;
    } catch {
      break;
    }
    validation = victorValidate(text);
  }

  return {
    reply: text,
    provider: `Victor · ${route.intent} · via ${provider} · ${validation.score}%`
  };
}

// ─── Chat endpoint ─────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const sendError = (msg) => { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); };

  // FIX (Bug #8): cancel provider fetch if browser disconnects mid-stream
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];
    const model       = (req.body.model || 'auto').toLowerCase();
    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    if (userMessage.length > 12000) return sendError('Message too long (max 12000 chars)');

    // FIX (Bug #1): strip any injected system roles from client-supplied history
    const safeHistory = history
      .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-10);

    const messages = [
      { role: 'system', content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. When the user sends file contents, read them carefully and answer based on that content. Refuse harmful or illegal requests politely.' },
      ...safeHistory,
      { role: 'user', content: userMessage }
    ];

    // Pass abort signal so fetch is cancelled if user disconnects
    const { reply, provider } = model === 'victor'
      ? await runVictorPipeline(messages, reqController.signal)
      : await getAIReply(messages, model, reqController.signal);

    const words = reply.split(' ');
    const CHUNK_SIZE = 8;
    for (let i = 0; i < words.length; i += CHUNK_SIZE) {
      const chunk = words.slice(i, i + CHUNK_SIZE).join(' ') + ' ';
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      await new Promise(r => setTimeout(r, 30));
    }
    res.write(`data: ${JSON.stringify({ done: true, provider })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Chat failed:', err.message);
    sendError('Nova AI is temporarily busy. Please try again in a moment.');
  }
});

// ─── Catch-all ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[OK]   Nova AI v2.0 running on port ${PORT}`);
  console.log(`[OK]   Environment: ${ENV.NODE_ENV}`);
  console.log(`[OK]   Base URL: ${ENV.BASE_URL}`);
}).on('error', (err) => {
  console.error(`[ERR]  Server failed to start: ${err.message}`);
  process.exit(1);
});
