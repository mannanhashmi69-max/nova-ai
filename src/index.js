const express = require('express');
const cors = require('cors');
const path = require('path');

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

  const sendError = (msg) => {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  };

  try {
    const userMessage = req.body.message;
    if (!userMessage) return sendError('Message is required');

    const fetch = require('node-fetch');
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: 'You are Nova AI, a helpful, concise, and friendly assistant.' },
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!response.ok) return sendError(`AI error: ${response.status}`);

    const data = await response.json();
    const aiReply = data.choices?.[0]?.message?.content || 'Sorry, no response.';

    const words = aiReply.split(' ');
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ chunk: word + ' ' })}\n\n`);
      await new Promise(r => setTimeout(r, 30));
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    sendError('AI service temporarily unavailable. Please try again.');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Nova AI running on port ${PORT}`));
