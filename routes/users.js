const express = require('express');
const multer = require('multer');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('../db');
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

router.patch('/me', requireAuth, (req, res) => {
  const { name, bio, website } = req.body;
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  db.prepare('UPDATE users SET name = ?, bio = ?, website = ? WHERE id = ?').run(
    name ?? current.name,
    bio ?? current.bio,
    website ?? current.website,
    req.userId
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ user: publicUser(updated) });
});

router.post('/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded (field name: avatar)' });
  const avatarUrl = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.userId);
  res.json({ avatarUrl });
});

router.get('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE followee_id = ?').get(req.params.id).c;
  const following = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id = ?').get(req.params.id).c;
  res.json({ user: { ...publicUser(user), followers, following } });
});

router.post('/:id/follow', requireAuth, (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.userId, req.params.id);
  res.json({ following: true });
});
router.delete('/:id/follow', requireAuth, (req, res) => {
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.userId, req.params.id);
  res.json({ following: false });
});

router.get('/', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const rows = db
    .prepare('SELECT id, name, bio, avatar_url FROM users WHERE lower(name) LIKE ? LIMIT 20')
    .all(`%${q}%`);
  res.json({ users: rows.map(r => ({ id: r.id, name: r.name, bio: r.bio, avatarUrl: r.avatar_url })) });
});

module.exports = router;