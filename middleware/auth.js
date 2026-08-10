const jwt = require('jsonwebtoken');
const { query } = require('../db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const { rows } = await query('SELECT id FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0]) {
      return res.status(401).json({ error: 'Your account could not be found. Please log in again.' });
    }
  } catch (err) {
    return next(err);
  }
  req.userId = payload.sub;
  next();
}

module.exports = { requireAuth };
