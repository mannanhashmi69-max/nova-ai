const express = require('express');
const cors = require('cors');
const path = require('path');

// NOTE: No require('node-fetch') at the top.
// node-fetch v3 is ESM-only — must use dynamic import() inside functions.

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    message: 'Nova AI is running!',
    timestamp: new Date().toISOString()
  });
});

// ─── Guest Login ──────────────────────────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const token = 'guest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  res.json({ success: true, token, username: 'Guest' });
});

// ─── Chat (SSE streaming) ─────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {

  // Send SSE headers immediately so the client knows streaming has started
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // ← critical: sends headers to client right now

  // Helper to send errors through the stream instead of crashing
  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    const userMessage = req.body.message;
    const history    = req.body.history || []; // optional conversation history

    if (!userMessage || typeof userMessage !== 'string') {
      return sendError('Message is required');
    }

    if (userMessage.length > 4000) {
      return sendError('Message is too long. Please keep it under 4000 characters.');
    }

    // Build the message array (system prompt + history + new message)
    const messages = [
      {
        role: 'system',
        content:
          'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. ' +
          'Be concise, clear, and friendly. Refuse harmful or illegal requests politely.'
      },
      ...history.slice(-10), // keep last 10 messages to avoid token limits
      { role: 'user', content: userMessage }
    ];

    // Dynamic import — the correct way to use node-fetch v3 with CommonJS
    const { default: fetch } = await import('node-fetch');

    const response = await fetch('https://text.pollinations.ai/openai', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:    'openai',
        messages: messages
        // stream: false is the default — more reliable than streaming from Pollinations
      })
    });

    // Handle non-200 responses from Pollinations
    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Pollinations error ${response.status}:`, errorBody);
      return sendError(`AI service returned an error (${response.status}). Please try again.`);
    }

    const data    = await response.json();
    const aiReply = data.choices?.[0]?.message?.content?.trim()
                 || 'Sorry, I could not generate a response. Please try again.';

    // Stream the reply word-by-word (smooth UX without character-level slowness)
    const words = aiReply.split(' ');
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ chunk: word + ' ' })}\n\n`);
      await new Promise(r => setTimeout(r, 25)); // 25ms per word ≈ natural reading pace
    }

    // Signal to the frontend that streaming is complete
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    sendError('Nova AI is temporarily unavailable. Please try again in a moment.');
  }
});

// ─── Catch-all: serve frontend for any unknown route ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Nova AI running on port ${PORT}`);
});
