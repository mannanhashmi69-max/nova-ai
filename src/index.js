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

    // Use node-fetch directly — avoids polyfill timing issues on Railway
    const { default: fetch } = await import('node-fetch');

    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          {
            role: 'system',
            content: 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful.'
          },
          { role: 'user', content: userMessage }
        ]
        // stream: false is the default — non-streaming is more reliable
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Pollinations error:', response.status, errorText);
      return sendError(`AI service error: ${response.status}`);
    }

    const data = await response.json();
    const aiReply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    // Send in word chunks (faster than char-by-char, smoother than one big send)
    const words = aiReply.split(' ');
    for (const word of words) {
      res.write(`data: ${JSON.stringify({ chunk: word + ' ' })}\n\n`);
      await new Promise(r => setTimeout(r, 30)); // 30ms per word is smooth
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    sendError('AI service temporarily unavailable. Please try again.');
  }
});
