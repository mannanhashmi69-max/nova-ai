const express = require('express');
const cors    = require('cors');
const path    = require('path');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Environment ───────────────────────────────────────────
const ENV = {
  GROQ_KEY:   (process.env.GROQ_API_KEY   || '').trim(),
  GEMINI_KEY: (process.env.GEMINI_API_KEY || '').trim()
};

(function validateEnv() {
  const checks = [
    { val: ENV.GROQ_KEY,   prefix: 'gsk_',   label: 'Groq',   key: 'GROQ_API_KEY'   },
    { val: ENV.GEMINI_KEY, prefix: 'AIzaSy', label: 'Gemini', key: 'GEMINI_API_KEY' }
  ];
  for (const { val, prefix, label, key } of checks) {
    if (!val)                         console.warn (`⚠️  ${key} not set — ${label} disabled`);
    else if (!val.startsWith(prefix)) console.error(`❌ ${key} looks wrong — should start with "${prefix}"`);
    else                              console.log  (`✅ ${key} loaded (${label})`);
  }
})();

// ─── Helpers ───────────────────────────────────────────────
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
    image:     { pollinations: true },
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

  // Using Pollinations AI - Free, no auth, reliable
  try {
    const url      = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${size}&height=${size}&nologo=true&seed=${Date.now()}`;
    const response = await fetchWithTimeout(url, {}, 15000);
    const ct       = response.headers.get('content-type') || '';

    if (response.ok && ct.startsWith('image/')) {
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const ext    = ct.includes('png') ? 'png' : 'jpeg';
      return res.json({ imageUrl: `data:image/${ext};base64,${base64}`, source: 'pollinations' });
    }
    throw new Error(`API returned status ${response.status}`);
  } catch (err) {
    console.error('Image error:', err.message);
    res.status(500).json({ error: 'Failed to generate image. Please try a different prompt.' });
  }
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
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages, max_tokens: 1024, temperature: 0.7 })
        },
        15000
      );
      if (res.status === 429) throw new RateLimitError('Groq');
      if (!res.ok) throw new Error(`Groq ${res.status}`);
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

      const body = { contents: fixedTurns, generationConfig: { maxOutputTokens: 1024, temperature: 0.7 } };
      if (systemMsg.trim()) body.system_instruction = { parts: [{ text: systemMsg }] };

      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${ENV.GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Gemini');
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
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
    if (cooldown && now < cooldown) return false;
    return true;
  });

  if (providers.length === 0) throw new Error('All providers unavailable or in cooldown');

  let lastError = null;
  for (const provider of providers) {
    try {
      const reply = await provider.call(messages);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      if (err instanceof RateLimitError) providerCooldowns.set(provider.name, Date.now() + 60_000);
      lastError = err;
    }
  }
  throw new Error('All providers failed. Last: ' + lastError?.message);
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
    if (userMessage.length > 4000) return sendError('Message too long (max 4000 chars)');

    const messages = [
      { role: 'system', content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. Refuse harmful or illegal requests politely.' },
      ...history.slice(-10),
      { role: 'user', content: userMessage }
    ];

    const { reply, provider } = await getAIReply(messages);

    for (const word of reply.split(' ')) {
      res.write(`data: ${JSON.stringify({ chunk: word + ' ' })}\n\n`);
      await new Promise(r => setTimeout(r, 15));
    }
    res.write(`data: ${JSON.stringify({ done: true, provider })}\n\n`);
    res.end();

  } catch (err) {
    sendError('Nova AI is temporarily busy. Please try again in a moment.');
  }
});

// ─── Frontend ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Nova AI running on port ${PORT}`));
