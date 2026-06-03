const express = require('express');
const cors    = require('cors');
const path    = require('path');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Startup: validate environment ────────────────────────
(function validateEnv() {
  const checks = [
    { key: 'GROQ_API_KEY',   prefix: 'gsk_',    label: 'Groq'   },
    { key: 'GEMINI_API_KEY', prefix: 'AIzaSy',  label: 'Gemini' },
    { key: 'HF_TOKEN',       prefix: 'hf_',     label: 'Hugging Face' }
  ];
  for (const { key, prefix, label } of checks) {
    const val = process.env[key];
    if (!val) {
      console.warn(`⚠️  ${key} not set — ${label} disabled`);
    } else if (!val.trim().startsWith(prefix)) {
      console.error(`❌ ${key} looks wrong (should start with "${prefix}") — check for typos`);
    } else {
      console.log(`✅ ${key} loaded`);
    }
  }
})();

// ─── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    providers: {
      groq:       !!process.env.GROQ_API_KEY,
      gemini:     !!process.env.GEMINI_API_KEY,
      pollinations: true
    },
    video:     !!process.env.HF_TOKEN,
    timestamp: new Date().toISOString()
  });
});

// ─── Guest login ───────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const token = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ success: true, token, username: 'Guest' });
});

// ─── AI providers ──────────────────────────────────────────
class RateLimitError extends Error {
  constructor(provider) {
    super(`${provider} rate limit reached`);
    this.name     = 'RateLimitError';
    this.provider = provider;
  }
}

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// Fix Bug 4: ensure Gemini gets alternating turns
function fixGeminiHistory(messages) {
  const turns = [];
  let lastRole = null;
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    if (role === lastRole) {
      // Merge consecutive same-role messages
      turns[turns.length - 1].parts[0].text += '\n' + msg.content;
    } else {
      turns.push({ role, parts: [{ text: msg.content }] });
      lastRole = role;
    }
  }
  // Gemini requires last turn to be 'user'
  if (turns.length && turns[turns.length - 1].role !== 'user') {
    turns.push({ role: 'user', parts: [{ text: '...' }] });
  }
  return turns;
}

const AI_PROVIDERS = [
  {
    name:      'Groq',
    available: () => !!process.env.GROQ_API_KEY,
    call:      async (messages) => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`
          },
          body: JSON.stringify({
            model:       'llama-3.1-8b-instant',  // Fix Bug 3: updated model name
            messages,
            max_tokens:  1024,
            temperature: 0.7
          })
        },
        15000
      );
      if (res.status === 429) throw new RateLimitError('Groq');
      if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text().then(t=>t.slice(0,100))}`);
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }
  },
  {
    name:      'Gemini',
    available: () => !!process.env.GEMINI_API_KEY,
    call:      async (messages) => {
      const systemMsg = messages.find(m => m.role === 'system')?.content || '';
      const userMsgs  = messages.filter(m => m.role !== 'system');
      const contents  = fixGeminiHistory(userMsgs);  // Fix Bug 4

      const body = {
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
      };
      // Fix Bug 2: only add system_instruction if non-empty
      if (systemMsg.trim()) {
        body.system_instruction = { parts: [{ text: systemMsg }] };
      }

      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY.trim()}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body)
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Gemini');
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text().then(t=>t.slice(0,100))}`);
      const data = await res.json();
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
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }
  }
];

async function getAIReply(messages) {
  const providers = AI_PROVIDERS.filter(p => p.available());
  let   lastError = null;
  for (const provider of providers) {
    try {
      console.log(`Trying ${provider.name}…`);
      const reply = await provider.call(messages);
      console.log(`✅ ${provider.name} succeeded`);
      return { reply, provider: provider.name };
    } catch (err) {
      console.warn(`⚠️  ${provider.name} failed: ${err.message}`);
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

  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];

    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    if (userMessage.length > 4000) return sendError('Message too long (max 4000 characters)');

    const messages = [
      {
        role:    'system',
        content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. Refuse harmful or illegal requests politely.'
      },
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
    console.error('All providers failed:', err.message);
    sendError('Nova AI is temporarily busy. Please try again in a moment.');
  }
});

// ─── Video generation ──────────────────────────────────────
const VIDEO_MODEL    = 'damo-vilab/text-to-video-ms-1.7b';
const JOB_TTL_MS     = 10 * 60 * 1000;
const GEN_TIMEOUT_MS = 90 * 1000;
const MAX_CONCURRENT = 3;

const videoJobs  = new Map();
let   activeJobs = 0;

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of videoJobs.entries()) {
    if (job.createdAt < cutoff) videoJobs.delete(id);
  }
}, JOB_TTL_MS);

app.post('/api/generate-video', (req, res) => {
  if (!process.env.HF_TOKEN) return res.status(503).json({ error: 'Video not configured.' });
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Prompt required' });
  if (prompt.length > 500)  return res.status(400).json({ error: 'Prompt too long' });
  if (activeJobs >= MAX_CONCURRENT) return res.status(429).json({ error: 'Server busy. Try again shortly.' });

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  videoJobs.set(jobId, { status:'processing', prompt, createdAt:Date.now(), videoUrl:null, error:null });

  generateVideoAsync(jobId, prompt).catch(err => {
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

async function generateVideoAsync(jobId, prompt) {
  activeJobs++;
  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS);
    const response   = await fetch(
      `https://api-inference.huggingface.co/models/${VIDEO_MODEL}`,
      {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.HF_TOKEN.trim()}`
        },
        body: JSON.stringify({ inputs: prompt, parameters: { num_frames:16, fps:8 } })
      }
    );
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text();
      if (response.status === 503) throw new Error('Model warming up. Retry in 20s.');
      if (response.status === 401) throw new Error('Invalid HF_TOKEN. Check Railway variables.');
      throw new Error(`HF ${response.status}: ${body.slice(0,200)}`);
    }
    const buf     = await response.arrayBuffer();
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
