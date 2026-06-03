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
  GEMINI_KEY: (process.env.GEMINI_API_KEY || '').trim(),
  HF_TOKEN:   (process.env.HF_TOKEN       || '').trim(),
};

(function validateEnv() {
  const checks = [
    { val: ENV.GROQ_KEY,   prefix: 'gsk_',   label: 'Groq',         key: 'GROQ_API_KEY'   },
    { val: ENV.GEMINI_KEY, prefix: 'AIzaSy', label: 'Gemini',       key: 'GEMINI_API_KEY' },
    { val: ENV.HF_TOKEN,   prefix: 'hf_',    label: 'Hugging Face', key: 'HF_TOKEN'       }
  ];
  for (const { val, prefix, label, key } of checks) {
    if (!val)                    console.warn (`⚠️  ${key} not set — ${label} disabled`);
    else if (!val.startsWith(prefix)) console.error(`❌ ${key} looks wrong — should start with "${prefix}"`);
    else                         console.log  (`✅ ${key} loaded (${label})`);
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
    image:     { pollinations: true, huggingface: !!ENV.HF_TOKEN },
    video:     !!ENV.HF_TOKEN,
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

  // Fix Bug 1: don't use HEAD — actually fetch the image and verify content-type
  try {
    const url      = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${size}&height=${size}&nologo=true&seed=${Date.now()}`;
    const response = await fetchWithTimeout(url, {}, 15000);
    const ct       = response.headers.get('content-type') || '';

    if (response.ok && ct.startsWith('image/')) {
      // Stream it through to avoid CORS issues and verify it's real
      const buffer  = await response.arrayBuffer();
      const base64  = Buffer.from(buffer).toString('base64');
      const ext     = ct.includes('png') ? 'png' : 'jpeg';
      return res.json({
        imageUrl: `data:image/${ext};base64,${base64}`,
        source:   'pollinations'
      });
    }
    throw new Error(`Pollinations returned ${response.status} ${ct}`);

  } catch (err) {
    console.warn('Pollinations image failed:', err.message, '— trying HF…');
  }

  // HF fallback
  if (!ENV.HF_TOKEN) {
    return res.status(503).json({
      error: 'Image generation unavailable. Add HF_TOKEN to Railway variables.'
    });
  }

  try {
    const hfRes = await fetchWithTimeout(
      'https://api-inference.huggingface.co/models/stabilityai/sdxl-turbo',
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${ENV.HF_TOKEN}`  // pre-trimmed
        },
        body: JSON.stringify({
          inputs:     prompt,
          parameters: { num_inference_steps: 4, guidance_scale: 0.0 }
        })
      },
      35000
    );

    if (!hfRes.ok) {
      const body = await hfRes.text();
      if (hfRes.status === 503) throw new Error('HF model warming up. Retry in 20 seconds.');
      if (hfRes.status === 401) throw new Error('Invalid HF_TOKEN. Check Railway variables.');
      throw new Error(`HF ${hfRes.status}: ${body.slice(0, 120)}`);
    }

    const ct = hfRes.headers.get('content-type') || 'image/jpeg';
    const buf = await hfRes.arrayBuffer();
    res.json({
      imageUrl: `data:${ct};base64,${Buffer.from(buf).toString('base64')}`,
      source:   'huggingface'
    });

  } catch (err) {
    console.error('HF image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Chat providers ────────────────────────────────────────

// Fix Bug 4: don't include the current user message in history before fixing turns
function fixGeminiHistory(historyOnly) {
  const turns   = [];
  let lastRole  = null;
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
            'Authorization': `Bearer ${ENV.GROQ_KEY}`  // pre-trimmed, never undefined
          },
          body: JSON.stringify({
            model:       'llama-3.1-8b-instant',
            messages,
            max_tokens:  1024,
            temperature: 0.7
          })
        },
        15000
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
      // Fix Bug 4: separate history from current user message
      const history    = messages.filter(m => m.role !== 'system' && m.role !== 'user' || messages.indexOf(m) < messages.length - 1);
      const lastMsg    = messages[messages.length - 1]; // always the current user message
      const fixedTurns = fixGeminiHistory(messages.filter(m => m.role !== 'system').slice(0, -1));

      // Append current user message cleanly
      fixedTurns.push({ role: 'user', parts: [{ text: lastMsg.content }] });

      const body = {
        contents:         fixedTurns,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      };
      if (systemMsg.trim()) {
        body.system_instruction = { parts: [{ text: systemMsg }] };
      }

      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${ENV.GEMINI_KEY}`,
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) },
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
        { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model:'openai', messages }) },
        25000
      );
      if (res.status === 429) throw new RateLimitError('Pollinations');
      if (!res.ok) throw new Error(`Pollinations ${res.status}`);
      const data = await safeJson(res); // Fix Bug 6: use safeJson
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
      console.log(`⏸  ${p.name} cooling down, skipping`);
      return false;
    }
    return true;
  });

  if (providers.length === 0) throw new Error('All providers unavailable or in cooldown');

  let lastError = null;
  for (const provider of providers) {
    try {
      console.log(`Trying ${provider.name}…`);
      const reply = await provider.call(messages);
      console.log(`✅ ${provider.name} succeeded`);
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      console.warn(`⚠️  ${provider.name} failed: ${err.message}`);
      if (err instanceof RateLimitError) {
        providerCooldowns.set(provider.name, Date.now() + 60_000);
      }
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
      { role:'system', content:'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. Refuse harmful or illegal requests politely.' },
      ...history.slice(-10),
      { role:'user', content: userMessage }
    ];

    const { reply, provider } = await getAIReply(messages);

    for (const word of reply.split(' ')) {
      res.write(`data: ${JSON.stringify({ chunk: word + ' ' })}\n\n`);
      await new Promise(r => setTimeout(r, 15));
    }
    res.write(`data: ${JSON.stringify({ done: true, provider })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Chat failed:', err.message);
    sendError('Nova AI is temporarily busy. Please try again in a moment.');
  }
});

// ─── Video generation ──────────────────────────────────────
const VIDEO_MODEL    = 'damo-vilab/text-to-video-ms-1.7b';
const JOB_TTL_MS     = 10 * 60 * 1000;
const GEN_TIMEOUT_MS = 90 * 1000;
const MAX_CONCURRENT = 3;
const MAX_MAP_SIZE   = 100; // Fix Bug 5: hard cap on Map size

const videoJobs  = new Map();
let   activeJobs = 0;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of videoJobs.entries()) {
    if (job.createdAt < cutoff) videoJobs.delete(id);
  }
}, JOB_TTL_MS);

app.post('/api/generate-video', (req, res) => {
  if (!ENV.HF_TOKEN) return res.status(503).json({ error: 'Video not configured. Add HF_TOKEN to Railway.' });
  if (videoJobs.size >= MAX_MAP_SIZE) return res.status(503).json({ error: 'Server storage full. Try again in a few minutes.' });

  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Prompt required' });
  if (prompt.length > 500)  return res.status(400).json({ error: 'Prompt too long (max 500 chars)' });
  if (activeJobs >= MAX_CONCURRENT) return res.status(429).json({ error: 'Server busy. Try again shortly.' });

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  videoJobs.set(jobId, { status:'processing', prompt, createdAt:Date.now(), videoUrl:null, error:null });

  generateVideoAsync(jobId).catch(err => {
    const current = videoJobs.get(jobId);
    if (current) videoJobs.set(jobId, { ...current, status:'failed', error:err.message });
  });

  res.json({ jobId, status:'processing', pollUrl:`/api/video-status/${jobId}` });
});

app.get('/api/video-status/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  const { status, videoUrl, error, prompt } = job;
  res.json({ status, videoUrl, error, prompt });
});

async function generateVideoAsync(jobId) {
  const job = videoJobs.get(jobId);
  if (!job) return;                        // guard against race condition
  if (!ENV.HF_TOKEN) {                     // Fix Bug 3: safe check using pre-trimmed ENV
    videoJobs.set(jobId, { ...job, status:'failed', error:'HF_TOKEN missing' });
    return;
  }

  activeJobs++;
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);

    const response = await fetch(
      `https://api-inference.huggingface.co/models/${VIDEO_MODEL}`,
      {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${ENV.HF_TOKEN}`  // pre-trimmed, never .trim() at runtime
        },
        body: JSON.stringify({ inputs: job.prompt, parameters: { num_frames:16, fps:8 } })
      }
    );
    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 503) throw new Error('Model warming up. Retry in 20s.');
      if (response.status === 401) throw new Error('Invalid HF_TOKEN. Check Railway variables.');
      throw new Error(`HF ${response.status}: ${body.slice(0, 200)}`);
    }

    const buf      = await response.arrayBuffer();
    const videoUrl = `data:video/mp4;base64,${Buffer.from(buf).toString('base64')}`;
    const current  = videoJobs.get(jobId);
    if (current) videoJobs.set(jobId, { ...current, status:'completed', videoUrl });

  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out after 90s. Try a shorter prompt.');
    throw err;
  } finally {
    activeJobs--;
  }
}

// ─── Frontend ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Nova AI running on port ${PORT}`));
