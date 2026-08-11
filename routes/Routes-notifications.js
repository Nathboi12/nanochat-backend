const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Helper other route files can call to create a notification (not exposed as a route itself)
async function createNotification({ recipientId, actorId, type, postId }) {
  if (recipientId === actorId) return; // don't notify yourself
  const id = nanoid();
  await query(
    'INSERT INTO notifications (id, recipient_id, actor_id, type, post_id) VALUES ($1, $2, $3, $4, $5)',
    [id, recipientId, actorId, type, postId || null]
  );
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT n.*, u.name as actor_name, u.avatar_url as actor_avatar
       FROM notifications n JOIN users u ON u.id = n.actor_id
       WHERE n.recipient_id = $1 ORDER BY n.created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({
      notifications: rows.map(n => ({
        id: n.id, type: n.type, postId: n.post_id, read: !!n.read, createdAt: n.created_at,
        actor: { id: n.actor_id, name: n.actor_name, avatarUrl: n.actor_avatar },
      })),
    });
  } catch (err) { next(err); }
});

router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT COUNT(*) c FROM notifications WHERE recipient_id = $1 AND read = 0', [req.userId]);
    res.json({ count: Number(rows[0].c) });
  } catch (err) { next(err); }
});

router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read = 1 WHERE id = $1 AND recipient_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    await query('UPDATE notifications SET read = 1 WHERE recipient_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { router, createNotification };
