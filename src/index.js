const express = require('express');
const cors    = require('cors');
const path    = require('path');
const https   = require('https');
const dns     = require('dns');

// Force IPv4 globally — Railway free tier often fails IPv6 DNS resolution
dns.setDefaultResultOrder('ipv4first');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Environment ───────────────────────────────────────────
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
  console.log('✅  Image : Pollinations (free, no key) → Lexica search fallback');
  console.log('ℹ️   Video : disabled — no free public API exists');
})();

// ─── Helpers ───────────────────────────────────────────────
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
    image:     { pollinations: true, lexica: true },
    video:     false,
    timestamp: new Date().toISOString()
  });
});

// ─── Guest login ───────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const token = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ success: true, token, username: 'Guest' });
});

// ─── Image generation ──────────────────────────────────────
app.post('/api/image', async (req, res) => {
  const { prompt, size = '512' } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const seed = Date.now();
  const enc  = encodeURIComponent(prompt);

  const pollinationsUrls = [
    `https://image.pollinations.ai/prompt/${enc}?width=${size}&height=${size}&model=flux&nologo=true&seed=${seed}`,
    `https://image.pollinations.ai/prompt/${enc}?width=${size}&height=${size}&nologo=true&seed=${seed}`,
  ];

  for (const url of pollinationsUrls) {
    try {
      console.log(`Pollinations → ${url.slice(0, 80)}…`);
      const response = await fetchWithTimeout(url, { agent: ipv4Agent }, 40000);
      const ct       = response.headers.get('content-type') || '';
      if (response.ok && ct.startsWith('image/')) {
        const buffer = await response.arrayBuffer();
        const ext    = ct.includes('png') ? 'png' : 'jpeg';
        console.log('✅  Pollinations image succeeded');
        return res.json({
          imageUrl: `data:image/${ext};base64,${Buffer.from(buffer).toString('base64')}`,
          source:   'pollinations'
        });
      }
      console.warn(`   ✗ Pollinations returned HTTP ${response.status} / ${ct}`);
    } catch (err) {
      console.warn(`   ✗ Pollinations attempt failed: ${err.message}`);
    }
  }

  // Lexica fallback
  try {
    console.log('Pollinations failed — trying Lexica search fallback…');
    const lexRes = await fetchWithTimeout(
      `https://lexica.art/api/v1/search?q=${enc}`,
      { agent: ipv4Agent, headers: { 'User-Agent': 'NovaAI/1.0' } },
      20000
    );
    if (lexRes.ok) {
      const data   = await safeJson(lexRes);
      const images = (data.images || []).filter(img => img.src || img.srcSmall);
      if (images.length > 0) {
        const picked = images[Math.floor(Math.random() * Math.min(8, images.length))];
        const imgUrl = picked.src || picked.srcSmall;
        console.log(`   Fetching Lexica image: ${imgUrl.slice(0, 70)}…`);
        const imgRes = await fetchWithTimeout(imgUrl, { agent: ipv4Agent }, 20000);
        if (imgRes.ok) {
          const ct  = imgRes.headers.get('content-type') || 'image/jpeg';
          const buf = await imgRes.arrayBuffer();
          console.log('✅  Lexica fallback image succeeded');
          return res.json({
            imageUrl: `data:${ct};base64,${Buffer.from(buf).toString('base64')}`,
            source:   'lexica',
            note:     'Showing a visually similar image (Lexica) — Pollinations is temporarily slow.'
          });
        }
        console.warn(`   ✗ Lexica image fetch failed: HTTP ${imgRes.status}`);
      } else {
        console.warn('   ✗ Lexica returned zero images for this prompt');
      }
    } else {
      console.warn(`   ✗ Lexica search HTTP ${lexRes.status}`);
    }
  } catch (err) {
    console.warn(`   ✗ Lexica fallback error: ${err.message}`);
  }

  return res.status(503).json({
    error: '🖼️ Image generation is temporarily unavailable. Please try again in a moment.'
  });
});

// ─── Video generation (disabled) ───────────────────────────
app.post('/api/generate-video', (_req, res) => {
  return res.status(503).json({
    error: '🎬 Video generation is unavailable. Use the Image tab for free AI visuals.'
  });
});

app.get('/api/video-status/:jobId', (_req, res) => {
  return res.status(410).json({ error: 'Video generation is disabled.' });
});

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
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${ENV.GROQ_KEY}`
          },
          body: JSON.stringify({
            model:       'llama-3.3-70b-versatile',
            messages,
            max_tokens:  2048,
            temperature: 0.7
          })
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

      const body = {
        contents:         fixedTurns,
        generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
      };
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
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: 'openai', messages })
        },
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
    if (cooldown && now < cooldown) {
      console.log(`⏸   ${p.name} in cooldown`);
      return false;
    }
    return true;
  });

  if (providers.length === 0) throw new Error('All AI providers unavailable or in cooldown');

  let lastError = null;
  for (const provider of providers) {
    try {
      console.log(`Trying ${provider.name}…`);
      const reply = await provider.call(messages);
      console.log(`✅  ${provider.name} succeeded`);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      console.warn(`⚠️   ${provider.name} failed: ${err.message}`);
      if (err instanceof RateLimitError) {
        providerCooldowns.set(provider.name, Date.now() + 60_000);
      }
      lastError = err;
    }
  }
  throw new Error('All providers failed. Last error: ' + lastError?.message);
}

// ─── Chat endpoint ─────────────────────────────────────────
// FIX: message length limit raised to 12000 to support file contents
// FIX: streaming in 8-word chunks instead of 1 word — prevents markdown breaking
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];

    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    // FIX: raised from 4000 to 12000 to accommodate file contents sent from frontend
    if (userMessage.length > 12000) return sendError('Message too long (max 12000 chars)');

    const messages = [
      {
        role:    'system',
        content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. When the user sends file contents, read them carefully and answer based on that content. Refuse harmful or illegal requests politely.'
      },
      ...history.slice(-10),
      { role: 'user', content: userMessage }
    ];

    const { reply, provider } = await getAIReply(messages);

    // FIX: stream in 8-word chunks so markdown (code blocks, bold, lists)
    // doesn't get split mid-token and break rendering on the frontend
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

// ─── Catch-all → frontend ──────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅  Nova AI running on port ${PORT}`));
