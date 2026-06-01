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
  const testResponse = `You said: "${req.body.message}". This is a test. The server is working!`;
  for (const char of testResponse) {
    res.write(`data: ${JSON.stringify({ chunk: char })}\n\n`);
    await new Promise(r => setTimeout(r, 30));
  }
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Nova AI running on port ${PORT}`));
