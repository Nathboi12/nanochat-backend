require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initSchema } = require('./db');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const postRoutes = require('./routes/posts');
const goalRoutes = require('./routes/goals');
const messageRoutes = require('./routes/messages');
const liveRoutes = require('./routes/live');
const { router: notificationRoutes } = require('./routes/notifications');
const nanoRoutes = require('./routes/nano');

const app = express();

// --- CORS: explicit allowlist instead of a bare wildcard ---
// Add any other frontend URLs here (comma-separated) via the CLIENT_ORIGIN env var,
// e.g. CLIENT_ORIGIN=https://nathboi12.github.io,http://localhost:5500
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'https://nathboi12.github.io')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // no Origin header = same-origin/non-browser request (curl, health checks, etc.) — allow
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
}));

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Very simple in-memory rate limiter for auth endpoints ---
// Limits repeated signup/login attempts per IP. Resets every window.
const rateLimitBuckets = new Map();
function rateLimit({ windowMs = 15 * 60 * 1000, max = 20 } = {}) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a bit and try again.' });
    }
    bucket.count++;
    next();
  };
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'nanochat-backend' }));

app.use('/auth/signup', rateLimit({ max: 10 }));
app.use('/auth/login', rateLimit({ max: 20 }));

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/posts', postRoutes);
app.use('/goals', goalRoutes);
app.use('/conversations', messageRoutes);
app.use('/live', liveRoutes);
app.use('/notifications', notificationRoutes);
app.use('/nano', nanoRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err); // full technical detail stays in the server logs for debugging
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'This origin is not allowed to access the API.' });
  }
  if (err.code && /^[0-9]{5}$/.test(err.code)) {
    // Postgres error codes are 5-digit SQLSTATE codes (e.g. 23503 = FK violation). Never leak raw SQL errors.
    return res.status(500).json({ error: 'Something went wrong saving that. Please try again.' });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Nanochat backend listening on port ${PORT}`));
  })
  .catch(err => {
    console.error('FATAL: could not initialize database schema.', err);
    process.exit(1);
  });
