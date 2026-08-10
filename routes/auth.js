 const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function publicUser(u) {
  const followersRes = await query('SELECT COUNT(*) c FROM follows WHERE followee_id = $1', [u.id]);
  const followingRes = await query('SELECT COUNT(*) c FROM follows WHERE follower_id = $1', [u.id]);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    bio: u.bio,
    website: u.website,
    avatarUrl: u.avatar_url,
    goalStreak: u.goal_streak,
    normalStreak: u.normal_streak,
    score: u.score,
    followers: Number(followersRes.rows[0].c),
    following: Number(followingRes.rows[0].c),
  };
}

router.post('/signup', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: 'An account with that email already exists' });

    const id = nanoid();
    const hash = bcrypt.hashSync(password, 10);
    await query('INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)', [id, name, email.toLowerCase(), hash]);

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
    const token = jwt.sign({ sub: id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: await publicUser(rows[0]) });
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: await publicUser(user) });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: await publicUser(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
