  const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { createNotification } = require('./notifications');

const router = express.Router();

function serializePartnership(row, viewerId) {
  const otherId = row.requester_id === viewerId ? row.recipient_id : row.requester_id;
  const otherName = row.requester_id === viewerId ? row.recipient_name : row.requester_name;
  const otherAvatar = row.requester_id === viewerId ? row.recipient_avatar : row.requester_avatar;
  return {
    id: row.id,
    status: row.status,
    categoryId: row.category_id,
    requestedByMe: row.requester_id === viewerId,
    createdAt: row.created_at,
    partner: { id: otherId, name: otherName, avatarUrl: otherAvatar },
  };
}

const PARTNER_JOIN = `
  SELECT ap.*,
    ru.name as requester_name, ru.avatar_url as requester_avatar,
    ru2.name as recipient_name, ru2.avatar_url as recipient_avatar
  FROM accountability_partners ap
  JOIN users ru ON ru.id = ap.requester_id
  JOIN users ru2 ON ru2.id = ap.recipient_id
`;

router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const { toUserId, categoryId } = req.body;
    if (!toUserId) return res.status(400).json({ error: 'toUserId is required' });
    if (toUserId === req.userId) return res.status(400).json({ error: "You can't partner with yourself" });

    const existing = await query(
      `SELECT * FROM accountability_partners
       WHERE ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))
       AND category_id IS NOT DISTINCT FROM $3 AND status IN ('pending','active')`,
      [req.userId, toUserId, categoryId || null]
    );
    if (existing.rows[0]) return res.status(409).json({ error: 'A request or partnership already exists for this category' });

    const id = nanoid();
    await query(
      'INSERT INTO accountability_partners (id, requester_id, recipient_id, category_id) VALUES ($1, $2, $3, $4)',
      [id, req.userId, toUserId, categoryId || null]
    );
    await createNotification({ recipientId: toUserId, actorId: req.userId, type: 'partner_request' });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.get('/requests', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      PARTNER_JOIN + ` WHERE ap.recipient_id = $1 AND ap.status = 'pending' ORDER BY ap.created_at DESC`,
      [req.userId]
    );
    res.json({ requests: rows.map(r => serializePartnership(r, req.userId)) });
  } catch (err) { next(err); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      PARTNER_JOIN + ` WHERE (ap.requester_id = $1 OR ap.recipient_id = $1) AND ap.status IN ('active','pending') ORDER BY ap.created_at DESC`,
      [req.userId]
    );
    res.json({ partners: rows.map(r => serializePartnership(r, req.userId)) });
  } catch (err) { next(err); }
});

router.patch('/:id/accept', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM accountability_partners WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'Request not found' });
    if (p.recipient_id !== req.userId) return res.status(403).json({ error: 'Not your request to respond to' });
    await query("UPDATE accountability_partners SET status = 'active', responded_at = NOW() WHERE id = $1", [p.id]);
    await createNotification({ recipientId: p.requester_id, actorId: req.userId, type: 'partner_accept' });
    await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.requester_id, 'first_partner']);
    await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'first_partner']);
    res.json({ status: 'active' });
  } catch (err) { next(err); }
});
router.patch('/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM accountability_partners WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'Request not found' });
    if (p.recipient_id !== req.userId) return res.status(403).json({ error: 'Not your request to respond to' });
    await query("UPDATE accountability_partners SET status = 'declined', responded_at = NOW() WHERE id = $1", [p.id]);
    res.json({ status: 'declined' });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM accountability_partners WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'Partnership not found' });
    if (p.requester_id !== req.userId && p.recipient_id !== req.userId) return res.status(403).json({ error: 'Not your partnership' });
    await query("UPDATE accountability_partners SET status = 'ended' WHERE id = $1", [p.id]);
    res.json({ status: 'ended' });
  } catch (err) { next(err); }
});

router.get('/:id/goal', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM accountability_partners WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'Partnership not found' });
    if (p.requester_id !== req.userId && p.recipient_id !== req.userId) return res.status(403).json({ error: 'Not your partnership' });
    if (p.status !== 'active') return res.status(400).json({ error: 'Partnership is not active' });
    if (!p.category_id) return res.status(400).json({ error: 'This partnership is not tied to a specific goal category' });

    const otherId = p.requester_id === req.userId ? p.recipient_id : p.requester_id;
    // Custom goals mean a person can have several goals tagged with the same category —
    // show their most recently created active one in that category.
    const goalRes = await query(
      `SELECT * FROM user_goals WHERE user_id = $1 AND category_id = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [otherId, p.category_id]
    );
    if (!goalRes.rows[0]) return res.json({ goal: null });
    const goal = goalRes.rows[0];
    const msRes = await query('SELECT done FROM milestones WHERE goal_id = $1', [goal.id]);
    const total = msRes.rows.length, done = msRes.rows.filter(m => m.done).length;
    res.json({ goal: { id: goal.id, title: goal.title, progress: goal.progress, totalMilestones: total, doneMilestones: done } });
  } catch (err) { next(err); }
});

module.exports = router;
