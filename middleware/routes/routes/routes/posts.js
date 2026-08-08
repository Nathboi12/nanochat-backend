const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Optional-auth middleware to know if the requester liked posts, without requiring login
router.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const jwt = require('jsonwebtoken');
      req.userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    } catch (_) {}
  }
  next();
});

function serializePost(row, userId) {
  const likeCount = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id = ?').get(row.id).c;
  const liked = userId
    ? !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(row.id, userId)
    : false;
  const comments = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? ORDER BY c.created_at ASC`
    )
    .all(row.id)
    .map(c => ({ id: c.id, text: c.text, createdAt: c.created_at, author: { id: c.user_id, name: c.name, avatarUrl: c.avatar_url } }));

  return {
    id: row.id,
    body: row.body,
    mediaUrl: row.media_url,
    profileMode: row.profile_mode,
    categoryId: row.category_id,
    createdAt: row.created_at,
    likeCount,
    liked,
    comments,
    author: { id: row.user_id, name: row.name, avatarUrl: row.avatar_url },
  };
}

// GET /posts?mode=goal|normal  — main feed
router.get('/', (req, res) => {
  const mode = req.query.mode === 'normal' ? 'normal' : 'goal';
  const userId = req.userId;
  const rows = db
    .prepare(
      `SELECT p.*, u.name, u.avatar_url
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.profile_mode = ?
       ORDER BY p.created_at DESC LIMIT 50`
    )
    .all(mode);
  res.json({ posts: rows.map(r => serializePost(r, userId)) });
});

router.post('/', requireAuth, (req, res) => {
  const { body, profileMode, categoryId, mediaUrl } = req.body;
  if (!body || !profileMode) return res.status(400).json({ error: 'body and profileMode are required' });
  if (!['goal', 'normal'].includes(profileMode)) return res.status(400).json({ error: 'profileMode must be goal or normal' });

  const id = nanoid();
  db.prepare(
    'INSERT INTO posts (id, user_id, profile_mode, category_id, body, media_url) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId, profileMode, categoryId || null, body, mediaUrl || null);

  const row = db
    .prepare(`SELECT p.*, u.name, u.avatar_url FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`)
    .get(id);
  res.status(201).json({ post: serializePost(row, req.userId) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.user_id !== req.userId) return res.status(403).json({ error: 'Not your post' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

router.post('/:id/like', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.userId);
  res.json({ liked: true });
});
router.delete('/:id/like', requireAuth, (req, res) => {
  db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ liked: false });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const id = nanoid();
  db.prepare('INSERT INTO comments (id, post_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, req.params.id, req.userId, text);
  const c = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`
    )
    .get(id);
  res.status(201).json({
    comment: { id: c.id, text: c.text, createdAt: c.created_at, author: { id: c.user_id, name: c.name, avatarUrl: c.avatar_url } },
  });
});

// ---- Stories ----
router.get('/stories/feed', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.media_url, s.created_at, u.id as user_id, u.name, u.avatar_url
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at IS NULL OR s.expires_at > datetime('now')
       ORDER BY s.created_at DESC LIMIT 30`
    )
    .all();
  res.json({
    stories: rows.map(r => ({ id: r.id, mediaUrl: r.media_url, createdAt: r.created_at, author: { id: r.user_id, name: r.name, avatarUrl: r.avatar_url } })),
  });
});
router.post('/stories', requireAuth, (req, res) => {
  const { mediaUrl } = req.body;
  const id = nanoid();
  db.prepare("INSERT INTO stories (id, user_id, media_url, expires_at) VALUES (?, ?, ?, datetime('now', '+24 hours'))").run(
    id, req.userId, mediaUrl || null
  );
  res.status(201).json({ id });
});

module.exports = router;
