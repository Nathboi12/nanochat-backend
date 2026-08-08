const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function serializeStream(row) {
  const chat = db
    .prepare(
      `SELECT lc.id, lc.text, lc.created_at, u.name FROM live_chat_messages lc
       JOIN users u ON u.id = lc.user_id WHERE lc.stream_id = ? ORDER BY lc.created_at ASC LIMIT 100`
    )
    .all(row.id);
  return {
    id: row.id,
    title: row.title,
    profileMode: row.profile_mode,
    status: row.status,
    viewers: row.viewers,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    host: { id: row.host_id, name: row.host_name, avatarUrl: row.host_avatar },
    chat: chat.map(c => ({ id: c.id, text: c.text, who: c.name, createdAt: c.created_at })),
  };
}

router.get('/', (req, res) => {
  const mode = req.query.mode;
  const rows = db
    .prepare(
      `SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar
       FROM live_streams ls JOIN users u ON u.id = ls.host_id
       WHERE ls.status = 'live' ${mode ? 'AND ls.profile_mode = ?' : ''}
       ORDER BY ls.started_at DESC`
    )
    .all(...(mode ? [mode] : []));
  res.json({ streams: rows.map(serializeStream) });
});

router.get('/:id', (req, res) => {
  const row = db
    .prepare(`SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar FROM live_streams ls JOIN users u ON u.id = ls.host_id WHERE ls.id = ?`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Stream not found' });
  res.json({ stream: serializeStream(row) });
});

router.post('/', requireAuth, (req, res) => {
  const { title, profileMode = 'goal' } = req.body;
  const id = nanoid();
  db.prepare('INSERT INTO live_streams (id, host_id, profile_mode, title) VALUES (?, ?, ?, ?)').run(id, req.userId, profileMode, title || 'Live');
  const row = db
    .prepare(`SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar FROM live_streams ls JOIN users u ON u.id = ls.host_id WHERE ls.id = ?`)
    .get(id);
  res.status(201).json({ stream: serializeStream(row) });
});

router.post('/:id/end', requireAuth, (req, res) => {
  const stream = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  if (stream.host_id !== req.userId) return res.status(403).json({ error: 'Not your stream' });
  db.prepare("UPDATE live_streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ status: 'ended' });
});

router.post('/:id/join', (req, res) => {
  const stream = db.prepare('SELECT * FROM live_streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  db.prepare('UPDATE live_streams SET viewers = viewers + 1 WHERE id = ?').run(req.params.id);
  res.json({ viewers: stream.viewers + 1 });
});
router.post('/:id/leave', (req, res) => {
  db.prepare('UPDATE live_streams SET viewers = MAX(0, viewers - 1) WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/chat', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const id = nanoid();
  db.prepare('INSERT INTO live_chat_messages (id, stream_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, req.params.id, req.userId, text);
  res.status(201).json({ id });
});

module.exports = router;
