const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function serializeStream(row) {
  const chatRes = await query(
    `SELECT lc.id, lc.text, lc.created_at, u.name FROM live_chat_messages lc
     JOIN users u ON u.id = lc.user_id WHERE lc.stream_id = $1 ORDER BY lc.created_at ASC LIMIT 100`,
    [row.id]
  );
  return {
    id: row.id,
    title: row.title,
    profileMode: row.profile_mode,
    status: row.status,
    viewers: row.viewers,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    host: { id: row.host_id, name: row.host_name, avatarUrl: row.host_avatar },
    chat: chatRes.rows.map(c => ({ id: c.id, text: c.text, who: c.name, createdAt: c.created_at })),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const mode = req.query.mode;
    const sql = `SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar
                 FROM live_streams ls JOIN users u ON u.id = ls.host_id
                 WHERE ls.status = 'live' ${mode ? 'AND ls.profile_mode = $1' : ''}
                 ORDER BY ls.started_at DESC`;
    const { rows } = await query(sql, mode ? [mode] : []);
    const streams = [];
    for (const r of rows) streams.push(await serializeStream(r));
    res.json({ streams });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar FROM live_streams ls JOIN users u ON u.id = ls.host_id WHERE ls.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Stream not found' });
    res.json({ stream: await serializeStream(rows[0]) });
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, profileMode = 'goal' } = req.body;
    const id = nanoid();
    await query('INSERT INTO live_streams (id, host_id, profile_mode, title) VALUES ($1, $2, $3, $4)', [id, req.userId, profileMode, title || 'Live']);
    const { rows } = await query(
      `SELECT ls.*, u.name as host_name, u.avatar_url as host_avatar FROM live_streams ls JOIN users u ON u.id = ls.host_id WHERE ls.id = $1`,
      [id]
    );
    res.status(201).json({ stream: await serializeStream(rows[0]) });
  } catch (err) { next(err); }
});

router.post('/:id/end', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM live_streams WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Stream not found' });
    if (rows[0].host_id !== req.userId) return res.status(403).json({ error: 'Not your stream' });
    await query("UPDATE live_streams SET status = 'ended', ended_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ status: 'ended' });
  } catch (err) { next(err); }
});

router.post('/:id/join', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM live_streams WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Stream not found' });
    await query('UPDATE live_streams SET viewers = viewers + 1 WHERE id = $1', [req.params.id]);
    res.json({ viewers: rows[0].viewers + 1 });
  } catch (err) { next(err); }
});
router.post('/:id/leave', async (req, res, next) => {
  try {
    await query('UPDATE live_streams SET viewers = GREATEST(0, viewers - 1) WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/chat', requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const id = nanoid();
    await query('INSERT INTO live_chat_messages (id, stream_id, user_id, text) VALUES ($1, $2, $3, $4)', [id, req.params.id, req.userId, text]);
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

module.exports = router;
