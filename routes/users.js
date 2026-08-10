
    const express = require('express');
const multer = require('multer');
const path = require('path');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${nanoid()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  },
});

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    bio: u.bio,
    website: u.website,
    avatarUrl: u.avatar_url,
    goalStreak: u.goal_streak,
    normalStreak: u.normal_streak,
    score: u.score,
  };
}

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const followers = await query('SELECT COUNT(*) c FROM follows WHERE followee_id = $1', [req.userId]);
    const following = await query('SELECT COUNT(*) c FROM follows WHERE follower_id = $1', [req.userId]);
    res.json({ user: { ...publicUser(rows[0]), followers: Number(followers.rows[0].c), following: Number(following.rows[0].c) } });
  } catch (err) { next(err); }
});

router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { name, bio, website } = req.body;
    const current = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!current.rows[0]) return res.status(404).json({ error: 'User not found' });
    await query('UPDATE users SET name = $1, bio = $2, website = $3 WHERE id = $4', [
      name ?? current.rows[0].name,
      bio ?? current.rows[0].bio,
      website ?? current.rows[0].website,
      req.userId,
    ]);
    const updated = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    res.json({ user: publicUser(updated.rows[0]) });
  } catch (err) { next(err); }
});

router.post('/me/avatar', requireAuth, upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded (field name: avatar)' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.userId]);
    res.json({ avatarUrl });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const followers = await query('SELECT COUNT(*) c FROM follows WHERE followee_id = $1', [req.params.id]);
    const following = await query('SELECT COUNT(*) c FROM follows WHERE follower_id = $1', [req.params.id]);
    res.json({ user: { ...publicUser(rows[0]), followers: Number(followers.rows[0].c), following: Number(following.rows[0].c) } });
  } catch (err) { next(err); }
});

router.post('/:id/follow', requireAuth, async (req, res, next) => {
  try {
    if (req.params.id === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
    await query('INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, req.params.id]);
    res.json({ following: true });
  } catch (err) { next(err); }
});
router.delete('/:id/follow', requireAuth, async (req, res, next) => {
  try {
    await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [req.userId, req.params.id]);
    res.json({ following: false });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const { rows } = await query('SELECT id, name, bio, avatar_url FROM users WHERE lower(name) LIKE $1 LIMIT 20', [`%${q}%`]);
    res.json({ users: rows.map(r => ({ id: r.id, name: r.name, bio: r.bio, avatarUrl: r.avatar_url })) });
  } catch (err) { next(err); }
});

module.exports = router;
