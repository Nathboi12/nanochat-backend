
  const express = require('express');
const multer = require('multer');
const path = require('path');
const { nanoid } = require('nanoid');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Optional-auth: know if the requester liked posts, without requiring login for GET /
router.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.userId = jwt.verify(token, process.env.JWT_SECRET).sub; } catch (_) {}
  }
  next();
});

const mediaStorage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${nanoid()}${ext}`);
  },
});
const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});
router.post('/media', requireAuth, uploadMedia.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded (field name: file)' });
  res.status(201).json({ url: `/uploads/${req.file.filename}` });
});

async function serializePost(row, userId) {
  const likeCountRes = await query('SELECT COUNT(*) c FROM likes WHERE post_id = $1', [row.id]);
  let liked = false;
  if (userId) {
    const likedRes = await query('SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2', [row.id, userId]);
    liked = !!likedRes.rows[0];
  }
  const commentsRes = await query(
    `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name, u.avatar_url
     FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
    [row.id]
  );
  return {
    id: row.id,
    body: row.body,
    mediaUrl: row.media_url,
    profileMode: row.profile_mode,
    categoryId: row.category_id,
    createdAt: row.created_at,
    likeCount: Number(likeCountRes.rows[0].c),
    liked,
    comments: commentsRes.rows.map(c => ({ id: c.id, text: c.text, createdAt: c.created_at, author: { id: c.user_id, name: c.name, avatarUrl: c.avatar_url } })),
    author: { id: row.user_id, name: row.name, avatarUrl: row.avatar_url },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const mode = req.query.mode === 'normal' ? 'normal' : 'goal';
    const { rows } = await query(
      `SELECT p.*, u.name, u.avatar_url FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.profile_mode = $1 ORDER BY p.created_at DESC LIMIT 50`,
      [mode]
    );
    const posts = [];
    for (const row of rows) posts.push(await serializePost(row, req.userId));
    res.json({ posts });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { body, profileMode, categoryId, mediaUrl } = req.body;
    if (!body || !profileMode) return res.status(400).json({ error: 'body and profileMode are required' });
    if (!['goal', 'normal'].includes(profileMode)) return res.status(400).json({ error: 'profileMode must be goal or normal' });

    const id = nanoid();
    await query(
      'INSERT INTO posts (id, user_id, profile_mode, category_id, body, media_url) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.userId, profileMode, categoryId || null, body, mediaUrl || null]
    );
    const { rows } = await query(`SELECT p.*, u.name, u.avatar_url FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [id]);
    res.status(201).json({ post: await serializePost(rows[0], req.userId) });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your post' });
    await query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/:id/like', requireAuth, async (req, res, next) => {
  try {
    await query('INSERT INTO likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.userId]);
    res.json({ liked: true });
  } catch (err) { next(err); }
});
router.delete('/:id/like', requireAuth, async (req, res, next) => {
  try {
    await query('DELETE FROM likes WHERE post_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ liked: false });
  } catch (err) { next(err); }
});

router.post('/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const id = nanoid();
    await query('INSERT INTO comments (id, post_id, user_id, text) VALUES ($1, $2, $3, $4)', [id, req.params.id, req.userId, text]);
    const { rows } = await query(
      `SELECT c.id, c.text, c.created_at, u.id as user_id, u.name, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [id]
    );
    const c = rows[0];
    res.status(201).json({ comment: { id: c.id, text: c.text, createdAt: c.created_at, author: { id: c.user_id, name: c.name, avatarUrl: c.avatar_url } } });
  } catch (err) { next(err); }
});

router.get('/stories/feed', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.media_url, s.created_at, u.id as user_id, u.name, u.avatar_url
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.expires_at IS NULL OR s.expires_at > NOW()
       ORDER BY s.created_at DESC LIMIT 30`
    );
    res.json({ stories: rows.map(r => ({ id: r.id, mediaUrl: r.media_url, createdAt: r.created_at, author: { id: r.user_id, name: r.name, avatarUrl: r.avatar_url } })) });
  } catch (err) { next(err); }
});
router.post('/stories', requireAuth, async (req, res, next) => {
  try {
    const { mediaUrl } = req.body;
    const id = nanoid();
    await query("INSERT INTO stories (id, user_id, media_url, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')", [id, req.userId, mediaUrl || null]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

module.exports = router;
