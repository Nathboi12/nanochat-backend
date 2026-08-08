const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function serializeConversation(convo, userId) {
  const members = db
    .prepare(`SELECT u.id, u.name, u.avatar_url FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?`)
    .all(convo.id);
  const last = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(convo.id);
  const unread = db
    .prepare("SELECT COUNT(*) c FROM messages WHERE conversation_id = ? AND sender_id != ? AND read = 0")
    .get(convo.id, userId).c;
  return {
    id: convo.id,
    isGroup: !!convo.is_group,
    name: convo.name,
    pinnedMessage: convo.pinned_message,
    members,
    lastMessage: last ? { text: last.text, type: last.type, createdAt: last.created_at, senderId: last.sender_id } : null,
    unreadCount: unread,
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = ? ORDER BY c.created_at DESC`
    )
    .all(req.userId);
  res.json({ conversations: rows.map(r => serializeConversation(r, req.userId)) });
});

router.post('/direct', requireAuth, (req, res) => {
  const { userId: otherId } = req.body;
  if (!otherId) return res.status(400).json({ error: 'userId is required' });

  const existing = db
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
       WHERE c.is_group = 0`
    )
    .get(req.userId, otherId);

  if (existing) {
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
    return res.json({ conversation: serializeConversation(convo, req.userId) });
  }

  const id = nanoid();
  db.prepare('INSERT INTO conversations (id, is_group) VALUES (?, 0)').run(id);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, req.userId);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, otherId);
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  res.status(201).json({ conversation: serializeConversation(convo, req.userId) });
});

router.post('/group', requireAuth, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'name and memberIds[] are required' });
  }
  const id = nanoid();
  db.prepare('INSERT INTO conversations (id, is_group, name) VALUES (?, 1, ?)').run(id, name);
  db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, req.userId);
  const insertMember = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
  memberIds.forEach(mid => insertMember.run(id, mid));
  const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  res.status(201).json({ conversation: serializeConversation(convo, req.userId) });
});

function assertMember(convoId, userId) {
  return !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(convoId, userId);
}

router.get('/:id/messages', requireAuth, (req, res) => {
  if (!assertMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation' });
  const rows = db
    .prepare(
      `SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ORDER BY m.created_at ASC LIMIT 200`
    )
    .all(req.params.id);
  db.prepare("UPDATE messages SET read = 1 WHERE conversation_id = ? AND sender_id != ?").run(req.params.id, req.userId);
  res.json({
    messages: rows.map(m => ({
      id: m.id, type: m.type, text: m.text, replyToId: m.reply_to_id, createdAt: m.created_at,
      sender: { id: m.sender_id, name: m.sender_name },
    })),
  });
});

router.post('/:id/messages', requireAuth, (req, res) => {
  if (!assertMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation' });
  const { text, type = 'text', replyToId } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const id = nanoid();
  db.prepare('INSERT INTO messages (id, conversation_id, sender_id, type, text, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, req.params.id, req.userId, type, text, replyToId || null
  );
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  res.status(201).json({ message: { id: msg.id, type: msg.type, text: msg.text, replyToId: msg.reply_to_id, createdAt: msg.created_at, senderId: msg.sender_id } });
});

router.patch('/:id/pin', requireAuth, (req, res) => {
  if (!assertMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation' });
  const { text } = req.body;
  db.prepare('UPDATE conversations SET pinned_message = ? WHERE id = ?').run(text || null, req.params.id);
  res.json({ pinnedMessage: text || null });
});

module.exports = router;
