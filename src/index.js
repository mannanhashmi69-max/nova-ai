const express = require('express');
const cors = require('cors');
const path = require('path');

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', message: 'Nova AI is running!' });
});

app.post('/api/guest', (req, res) => {
  const token = 'guest-token-' + Date.now();
  res.json({ success: true, token, username: 'Guest' });
});

app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendError = (message) => {
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  };

  try {
    const userMessage = req.body.message;
    const history = req.body.history || [];

    if (!userMessage) {
      return sendError('Message is required');
    }

    const messages = [
      {
        role: 'system',
        content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful.'
      },
      ...history,
      { role: 'user', content: userMessage }
    ];

    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: messages,
        stream: true
      })
    });

    if (!response.ok) {
      return sendError(`AI service returned error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();

        if (payload === '[DONE]') {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
          return;
        }

        try {
          const data = JSON.parse(payload);
          const content = data.choices?.[0]?.delta?.content || '';
          if (content) {
            res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
          }
        } catch (e) {}
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    sendError('Nova AI encountered an error. Please try again.');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Nova AI running on port ${PORT}`));
