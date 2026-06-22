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
    if (!val)                         console.warn (`âš ï¸  ${key} not set â€” ${label} disabled`);
    else if (!val.startsWith(prefix)) console.error(`âŒ  ${key} looks wrong â€” expected prefix "${prefix}"`);
    else                              console.log  (`âœ…  ${key} loaded (${label})`);
  }
  console.log('âœ…  Image: Pollinations flux-schnell â†’ flux â†’ picsum fallback');
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

// â”€â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    providers: { groq: !!ENV.GROQ_KEY, gemini: !!ENV.GEMINI_KEY, pollinations: true, victor: true },
    timestamp: new Date().toISOString()
  });
});

// â”€â”€â”€ Models list (for model-picker UI) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'auto',         name: 'Auto',              description: 'Fastest reliable answer â€” tries providers in order',          available: true },
      { id: 'victor',       name: 'Victor',            description: 'Multi-agent: routes â†’ drafts â†’ validates â†’ refines',           available: true },
      { id: 'groq',         name: 'Groq Â· Llama 3.3',  description: 'Fast and high quality',                                        available: !!ENV.GROQ_KEY },
      { id: 'gemini',       name: 'Gemini 2.0',        description: "Google's flash model",                                         available: !!ENV.GEMINI_KEY },
      { id: 'pollinations', name: 'Pollinations',      description: 'Free, always available',                                       available: true }
    ]
  });
});

// â”€â”€â”€ Guest login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/guest', (req, res) => {
  const token = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ success: true, token, username: 'Guest' });
});

// â”€â”€â”€ Image generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Strategy:
//   1. Pollinations flux-schnell  (fast model, ~5s)
//   2. Pollinations flux          (standard model, ~15s)
//   3. Pollinations default       (bare endpoint fallback)
//   4. picsum.photos              (always works â€” random photo, never fails)
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
      console.log(`ðŸŽ¨ Trying Pollinations ${attempt.label}â€¦`);
      const response = await fetchWithTimeout(
        attempt.url,
        { agent: ipv4Agent, headers: { 'Accept': 'image/*' } },
        attempt.timeout
      );

      if (!response.ok) {
        console.warn(`   âœ— HTTP ${response.status}`);
        continue;
      }

      const ct = response.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        console.warn(`   âœ— Wrong content-type: ${ct}`);
        continue;
      }

      // Read full buffer â€” Railway can close stream early if we peek headers only
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) {
        console.warn(`   âœ— Buffer too small (${buffer.length} bytes) â€” likely an error page`);
        continue;
      }

      const ext = ct.includes('png') ? 'png' : 'jpeg';
      console.log(`âœ… Pollinations ${attempt.label} succeeded (${buffer.length} bytes)`);
      return res.json({
        imageUrl: `data:image/${ext};base64,${buffer.toString('base64')}`,
        source:   `pollinations-${attempt.label}`
      });
    } catch (err) {
      console.warn(`   âœ— Pollinations ${attempt.label} error: ${err.message}`);
    }
  }

  // â”€â”€ Guaranteed fallback: picsum.photos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Always returns a real photo. Not AI-generated but ALWAYS works.
  // Better than showing the user an error.
  console.log('âš ï¸  All Pollinations attempts failed â€” using picsum fallback');
  try {
    const picsumUrl = `https://picsum.photos/seed/${seed}/${sz}/${sz}`;
    const picsumRes = await fetchWithTimeout(picsumUrl, { agent: ipv4Agent }, 10000);
    if (picsumRes.ok) {
      const buf = Buffer.from(await picsumRes.arrayBuffer());
      console.log('âœ… Picsum fallback succeeded');
      return res.json({
        imageUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
        source:   'picsum',
        note:     'âš ï¸ AI generation is slow right now â€” showing a stock photo instead. Try again in a minute for AI art.'
      });
    }
  } catch (err) {
    console.warn(`   âœ— Picsum fallback error: ${err.message}`);
  }

  return res.status(503).json({
    error: 'ðŸ–¼ï¸ Image generation is temporarily unavailable on this server. Please try again in 1â€“2 minutes.'
  });
});

// â”€â”€â”€ Video (disabled) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/generate-video', (_req, res) => res.status(503).json({
  error: 'ðŸŽ¬ Video generation requires a paid API. Use the Image tab for free AI visuals.'
}));
app.get('/api/video-status/:jobId', (_req, res) => res.status(410).json({ error: 'Disabled.' }));

// â”€â”€â”€ Chat providers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

async function getAIReply(messages, preferred) {
  const now       = Date.now();
  let providers = AI_PROVIDERS.filter(p => {
    if (!p.available()) return false;
    const cooldown = providerCooldowns.get(p.name);
    if (cooldown && now < cooldown) { console.log(`â¸ ${p.name} in cooldown`); return false; }
    return true;
  });

  // FIX: if a specific model was requested, try it first â€” still falls back
  // to the rest of the chain on failure so the user always gets a reply.
  if (preferred && preferred !== 'auto' && preferred !== 'victor') {
    const idx = providers.findIndex(p => p.name.toLowerCase() === preferred.toLowerCase());
    if (idx > 0) providers = [providers[idx], ...providers.slice(0, idx), ...providers.slice(idx + 1)];
  }

  if (providers.length === 0) throw new Error('All AI providers unavailable or in cooldown');
  let lastError = null;
  for (const provider of providers) {
    try {
      console.log(`Trying ${provider.name}â€¦`);
      const reply = await provider.call(messages);
      console.log(`âœ… ${provider.name} succeeded`);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      console.warn(`âš ï¸ ${provider.name} failed: ${err.message}`);
      if (err instanceof RateLimitError) providerCooldowns.set(provider.name, Date.now() + 60_000);
      lastError = err;
    }
  }
  throw new Error('All providers failed. Last error: ' + lastError?.message);
}

// â”€â”€â”€ Victor: multi-agent reasoning pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Not a separate AI â€” it's a 5-stage process built ON TOP of
// the providers above: Router (classify intent) â†’ Processor
// (draft via real AI) â†’ Validator (score the draft) â†’
// Optimizer (re-prompt AI to improve, up to 2x if needed) â†’
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

async function victorOptimize(messages, draft) {
  const refineMessages = [
    ...messages,
    { role: 'assistant', content: draft },
    { role: 'user', content: 'Improve and tighten your previous answer â€” fix gaps, keep it accurate and well-structured. Reply with only the improved answer, nothing else.' }
  ];
  return getAIReply(refineMessages);
}

async function runVictorPipeline(messages) {
  const userMessage = messages[messages.length - 1].content;
  const route = victorRoute(userMessage);

  let { reply: text, provider } = await getAIReply(messages);
  let validation = victorValidate(text);
  let attempts = 0;

  while (!validation.isValid && attempts < 2) {
    attempts++;
    try {
      const opt = await victorOptimize(messages, text);
      text = opt.reply;
      provider = opt.provider;
    } catch {
      break; // keep best draft so far rather than fail the whole pipeline
    }
    validation = victorValidate(text);
  }

  return {
    reply: text,
    provider: `Victor Â· ${route.intent} Â· via ${provider} Â· ${validation.score}%`
  };
}

// â”€â”€â”€ Chat endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const sendError = (msg) => { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); };

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];
    const model       = (req.body.model || 'auto').toLowerCase(); // FIX: model selection
    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    if (userMessage.length > 12000) return sendError('Message too long (max 12000 chars)');

    const messages = [
      { role: 'system', content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. When the user sends file contents, read them carefully and answer based on that content. Refuse harmful or illegal requests politely.' },
      ...history.slice(-10),
      { role: 'user', content: userMessage }
    ];

    const { reply, provider } = model === 'victor'
      ? await runVictorPipeline(messages)
      : await getAIReply(messages, model);

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

// â”€â”€â”€ Catch-all â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`âœ… Nova AI running on port ${PORT}`));
