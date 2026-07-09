const express = require('express');
const db = require('../db');
const { generateTitle } = require('./titles');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use conversation history.' });
}

function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'Conversation history isn\u2019t configured on this server yet.' });
  next();
}

router.use(requireAuth, notReadyIfNoDb);

// GET /api/conversations?cursor=&archived=true|false
router.get('/', async (req, res) => {
  const archived = req.query.archived === 'true';
  const { items, nextCursor } = await db.listConversations(req.dbUser.id, { cursor: req.query.cursor || null, archived });
  res.json({ items, next_cursor: nextCursor });
});

// POST /api/conversations  { title? }
router.post('/', async (req, res) => {
  const conversation = await db.createConversation(req.dbUser.id, req.body?.title);
  res.status(201).json(conversation);
});

// GET /api/conversations/:id
router.get('/:id', async (req, res) => {
  const conversation = await db.getConversation(req.params.id, req.dbUser.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conversation);
});

// PATCH /api/conversations/:id  { title?, starred?, archived? }
router.patch('/:id', async (req, res) => {
  const { title, starred, archived } = req.body || {};
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    return res.status(400).json({ error: 'title must be a string under 200 characters' });
  }
  const conversation = await db.updateConversation(req.params.id, req.dbUser.id, { title, starred, archived });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conversation);
});

// DELETE /api/conversations/:id — soft delete only
router.delete('/:id', async (req, res) => {
  const result = await db.softDeleteConversation(req.params.id, req.dbUser.id);
  if (!result) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ deleted: true, id: result.id });
});

// GET /api/conversations/:id/messages?cursor=
router.get('/:id/messages', async (req, res) => {
  const conversation = await db.getConversation(req.params.id, req.dbUser.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  const { items, nextCursor } = await db.listMessages(req.params.id, { cursor: req.query.cursor || null });
  res.json({ items, next_cursor: nextCursor });
});

// POST /api/conversations/:id/messages  { role, content, provider?, model? }
router.post('/:id/messages', async (req, res) => {
  const conversation = await db.getConversation(req.params.id, req.dbUser.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const { role, content, provider, model } = req.body || {};
  if (!['user', 'assistant'].includes(role)) return res.status(400).json({ error: 'role must be "user" or "assistant"' });
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content is required' });

  const message = await db.addMessage(req.params.id, { role, content, provider, model });
  res.status(201).json(message);
});

// ── /api/search — separate top-level route per spec ───────────
const searchRouter = express.Router();
searchRouter.get('/', requireAuth, notReadyIfNoDb, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q query param is required' });
  const { items, nextCursor } = await db.searchConversations(req.dbUser.id, q, { cursor: req.query.cursor || null });
  res.json({ items, next_cursor: nextCursor });
});

// ── /api/export — separate top-level route per spec ───────────
// Built so a future 'pdf' format only needs one more case here.
const exportRouter = express.Router();
exportRouter.post('/', requireAuth, notReadyIfNoDb, async (req, res) => {
  const { conversationId, format = 'json' } = req.body || {};
  if (!['txt', 'markdown', 'json'].includes(format)) {
    return res.status(400).json({ error: 'format must be txt, markdown, or json' });
  }
  const conversation = await db.getConversation(conversationId, req.dbUser.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  // Export walks all pages of messages rather than assuming 50 is everything.
  let allMessages = [];
  let cursor = null;
  do {
    const page = await db.listMessages(conversationId, { cursor, limit: 200 });
    allMessages = allMessages.concat(page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const safeName = conversation.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) || 'conversation';

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.json"`);
    return res.json({ conversation, messages: allMessages });
  }

  const body = allMessages
    .map((m) => (format === 'markdown' ? `**${m.role === 'user' ? 'You' : 'Assistant'}:**\n\n${m.content}` : `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`))
    .join('\n\n---\n\n');
  const content = format === 'markdown' ? `# ${conversation.title}\n\n${body}\n` : `${conversation.title}\n${'='.repeat(conversation.title.length)}\n\n${body}\n`;

  res.setHeader('Content-Type', format === 'markdown' ? 'text/markdown' : 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format === 'markdown' ? 'md' : 'txt'}"`);
  res.send(content);
});

module.exports = { router, searchRouter, exportRouter };
