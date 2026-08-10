const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function serializeConversation(convo, userId) {
  const membersRes = await query(
    `SELECT u.id, u.name, u.avatar_url FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = $1`,
    [convo.id]
  );
  const lastRes = await query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1', [convo.id]);
  const unreadRes = await query('SELECT COUNT(*) c FROM messages WHERE conversation_id = $1 AND sender_id != $2 AND read = 0', [convo.id, userId]);
  const last = lastRes.rows[0];
  return {
    id: convo.id,
    isGroup: !!convo.is_group,
    name: convo.name,
    pinnedMessage: convo.pinned_message,
    members: membersRes.rows,
    lastMessage: last ? { text: last.text, type: last.type, createdAt: last.created_at, senderId: last.sender_id } : null,
    unreadCount: Number(unreadRes.rows[0].c),
  };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = $1 ORDER BY c.created_at DESC`,
      [req.userId]
    );
    const conversations = [];
    for (const r of rows) conversations.push(await serializeConversation(r, req.userId));
    res.json({ conversations });
  } catch (err) { next(err); }
});

router.post('/direct', requireAuth, async (req, res, next) => {
  try {
    const { userId: otherId } = req.body;
    if (!otherId) return res.status(400).json({ error: 'userId is required' });

    const existing = await query(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
       WHERE c.is_group = 0`,
      [req.userId, otherId]
    );
    if (existing.rows[0]) {
      const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [existing.rows[0].id]);
      return res.json({ conversation: await serializeConversation(rows[0], req.userId) });
    }

    const id = nanoid();
    await query('INSERT INTO conversations (id, is_group) VALUES ($1, 0)', [id]);
    await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [id, req.userId]);
    await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [id, otherId]);
    const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [id]);
    res.status(201).json({ conversation: await serializeConversation(rows[0], req.userId) });
  } catch (err) { next(err); }
});

router.post('/group', requireAuth, async (req, res, next) => {
  try {
    const { name, memberIds } = req.body;
    if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'name and memberIds[] are required' });
    }
    const id = nanoid();
    await query('INSERT INTO conversations (id, is_group, name) VALUES ($1, 1, $2)', [id, name]);
    await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)', [id, req.userId]);
    for (const mid of memberIds) {
      await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, mid]);
    }
    const { rows } = await query('SELECT * FROM conversations WHERE id = $1', [id]);
    res.status(201).json({ conversation: await serializeConversation(rows[0], req.userId) });
  } catch (err) { next(err); }
});

async function assertMember(convoId, userId) {
  const { rows } = await query('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [convoId, userId]);
  return !!rows[0];
}

router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (!(await assertMember(req.params.id, req.userId))) return res.status(403).json({ error: 'Not a member of this conversation' });
    const { rows } = await query(
      `SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
      [req.params.id]
    );
    await query('UPDATE messages SET read = 1 WHERE conversation_id = $1 AND sender_id != $2', [req.params.id, req.userId]);
    res.json({
      messages: rows.map(m => ({
        id: m.id, type: m.type, text: m.text, replyToId: m.reply_to_id, createdAt: m.created_at,
        sender: { id: m.sender_id, name: m.sender_name },
      })),
    });
  } catch (err) { next(err); }
});

router.post('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (!(await assertMember(req.params.id, req.userId))) return res.status(403).json({ error: 'Not a member of this conversation' });
    const { text, type = 'text', replyToId } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const id = nanoid();
    await query(
      'INSERT INTO messages (id, conversation_id, sender_id, type, text, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, req.params.id, req.userId, type, text, replyToId || null]
    );
    const { rows } = await query('SELECT * FROM messages WHERE id = $1', [id]);
    const msg = rows[0];
    res.status(201).json({ message: { id: msg.id, type: msg.type, text: msg.text, replyToId: msg.reply_to_id, createdAt: msg.created_at, senderId: msg.sender_id } });
  } catch (err) { next(err); }
});

router.patch('/:id/pin', requireAuth, async (req, res, next) => {
  try {
    if (!(await assertMember(req.params.id, req.userId))) return res.status(403).json({ error: 'Not a member of this conversation' });
    const { text } = req.body;
    await query('UPDATE conversations SET pinned_message = $1 WHERE id = $2', [text || null, req.params.id]);
    res.json({ pinnedMessage: text || null });
  } catch (err) { next(err); }
});

module.exports = router;
