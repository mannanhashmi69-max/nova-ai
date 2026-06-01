app.post('/api/chat', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const testMsg = `Echo: ${req.body.message}`;
  for (const char of testMsg) {
    res.write(`data: ${JSON.stringify({ chunk: char })}\n\n`);
    await new Promise(r => setTimeout(r, 30));
  }
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
});
