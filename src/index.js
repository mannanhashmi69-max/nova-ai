const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const dns     = require('dns');

dns.setDefaultResultOrder('ipv4first');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const ENV = {
  GROQ_KEY:   (process.env.GROQ_API_KEY   || '').trim(),
  GEMINI_KEY: (process.env.GEMINI_API_KEY || '').trim(),
};

(function validateEnv() {
  const checks = [
    { val: ENV.GROQ_KEY,   prefix: 'gsk_',   label: 'Groq',   key: 'GROQ_API_KEY'   },
    { val: ENV.GEMINI_KEY, prefix: 'AIzaSy', label: 'Gemini', key: 'GEMINI_API_KEY' },
  ];
  for (const { val, prefix, label, key } of checks) {
    if (!val)                         console.warn (`⚠️  ${key} not set — ${label} disabled`);
    else if (!val.startsWith(prefix)) console.error(`❌  ${key} looks wrong — expected prefix "${prefix}"`);
    else                              console.log  (`✅  ${key} loaded (${label})`);
  }
  console.log('✅  Image: Pollinations flux-schnell → flux → picsum fallback');
})();

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

// ─── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    providers: { groq: !!ENV.GROQ_KEY, gemini: !!ENV.GEMINI_KEY, pollinations: true },
    timestamp: new Date().toISOString()
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

app.post('/api/image', async (req, res) => {
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
    call:      async (messages) => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 2048, temperature: 0.7 })
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Groq');
      if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      return data.choices[0].message.content.trim();
    }
  },
  {
    name:      'Gemini',
    available: () => !!ENV.GEMINI_KEY,
    call:      async (messages) => {
      const systemMsg  = messages.find(m => m.role === 'system')?.content || '';
      const fixedTurns = fixGeminiHistory(messages.filter(m => m.role !== 'system').slice(0, -1));
      const lastMsg    = messages[messages.length - 1];
      fixedTurns.push({ role: 'user', parts: [{ text: lastMsg.content }] });
      const body = { contents: fixedTurns, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } };
      if (systemMsg.trim()) body.system_instruction = { parts: [{ text: systemMsg }] };
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${ENV.GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Gemini');
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      return data.candidates[0].content.parts[0].text.trim();
    }
  },
  {
    name:      'Pollinations',
    available: () => true,
    call:      async (messages) => {
      const res = await fetchWithTimeout(
        'https://text.pollinations.ai/openai',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages }) },
        25000
      );
      if (res.status === 429) throw new RateLimitError('Pollinations');
      if (!res.ok) throw new Error(`Pollinations ${res.status}`);
      const data = await safeJson(res);
      return data.choices[0].message.content.trim();
    }
  }
];

async function getAIReply(messages) {
  const now       = Date.now();
  const providers = AI_PROVIDERS.filter(p => {
    if (!p.available()) return false;
    const cooldown = providerCooldowns.get(p.name);
    if (cooldown && now < cooldown) { console.log(`⏸ ${p.name} in cooldown`); return false; }
    return true;
  });
  if (providers.length === 0) throw new Error('All AI providers unavailable or in cooldown');
  let lastError = null;
  for (const provider of providers) {
    try {
      console.log(`Trying ${provider.name}…`);
      const reply = await provider.call(messages);
      console.log(`✅ ${provider.name} succeeded`);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      console.warn(`⚠️ ${provider.name} failed: ${err.message}`);
      if (err instanceof RateLimitError) providerCooldowns.set(provider.name, Date.now() + 60_000);
      lastError = err;
    }
  }
  throw new Error('All providers failed. Last error: ' + lastError?.message);
}

// ─── Chat endpoint ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const sendError = (msg) => { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); };

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];
    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    if (userMessage.length > 12000) return sendError('Message too long (max 12000 chars)');

    const messages = [
      { role: 'system', content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. When the user sends file contents, read them carefully and answer based on that content. Refuse harmful or illegal requests politely.' },
      ...history.slice(-10),
      { role: 'user', content: userMessage }
    ];

    const { reply, provider } = await getAIReply(messages);

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
app.listen(PORT, () => console.log(`✅ Nova AI running on port ${PORT}`));
