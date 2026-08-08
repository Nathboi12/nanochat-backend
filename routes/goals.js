const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/categories', (req, res) => {
  res.json({ categories: db.prepare('SELECT * FROM goal_categories').all() });
});

function getOrCreateGoal(userId, categoryId) {
  let goal = db.prepare('SELECT * FROM user_goals WHERE user_id = ? AND category_id = ?').get(userId, categoryId);
  if (!goal) {
    const id = nanoid();
    db.prepare('INSERT INTO user_goals (id, user_id, category_id) VALUES (?, ?, ?)').run(id, userId, categoryId);
    goal = db.prepare('SELECT * FROM user_goals WHERE id = ?').get(id);
  }
  return goal;
}

function serializeGoal(goal) {
  const milestones = db.prepare('SELECT * FROM milestones WHERE goal_id = ? ORDER BY position ASC').all(goal.id);
  const checkins = db
    .prepare(
      `SELECT c.id, c.text, c.created_at, u.name FROM checkins c JOIN users u ON u.id = c.user_id
       WHERE c.goal_id = ? ORDER BY c.created_at DESC LIMIT 20`
    )
    .all(goal.id);
  const cheerSquad = db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url FROM cheer_squad cs JOIN users u ON u.id = cs.member_id WHERE cs.goal_id = ?`
    )
    .all(goal.id);
  return {
    id: goal.id,
    categoryId: goal.category_id,
    progress: goal.progress,
    milestones: milestones.map(m => ({ id: m.id, label: m.label, done: !!m.done })),
    checkins: checkins.map(c => ({ id: c.id, text: c.text, who: c.name, createdAt: c.created_at })),
    cheerSquad: cheerSquad.map(m => ({ id: m.id, name: m.name, avatarUrl: m.avatar_url })),
  };
}

router.get('/mine/:categoryId', requireAuth, (req, res) => {
  const goal = getOrCreateGoal(req.userId, req.params.categoryId);
  res.json({ goal: serializeGoal(goal) });
});

router.get('/mine', requireAuth, (req, res) => {
  const goals = db.prepare('SELECT * FROM user_goals WHERE user_id = ?').all(req.userId);
  res.json({ goals: goals.map(serializeGoal) });
});

router.post('/mine/:categoryId/milestones', requireAuth, (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: 'label is required' });
  const goal = getOrCreateGoal(req.userId, req.params.categoryId);
  const id = nanoid();
  const pos = db.prepare('SELECT COUNT(*) c FROM milestones WHERE goal_id = ?').get(goal.id).c;
  db.prepare('INSERT INTO milestones (id, goal_id, label, position) VALUES (?, ?, ?, ?)').run(id, goal.id, label, pos);
  res.status(201).json({ goal: serializeGoal(goal) });
});

function recomputeProgress(goalId) {
  const milestones = db.prepare('SELECT done FROM milestones WHERE goal_id = ?').all(goalId);
  if (milestones.length === 0) return;
  const done = milestones.filter(m => m.done).length;
  const progress = Math.round((done / milestones.length) * 100);
  db.prepare('UPDATE user_goals SET progress = ? WHERE id = ?').run(progress, goalId);
}

router.patch('/milestones/:id/toggle', requireAuth, (req, res) => {
  const milestone = db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
  if (!milestone) return res.status(404).json({ error: 'Milestone not found' });
  const goal = db.prepare('SELECT * FROM user_goals WHERE id = ?').get(milestone.goal_id);
  if (goal.user_id !== req.userId) return res.status(403).json({ error: 'Not your goal' });

  db.prepare('UPDATE milestones SET done = ? WHERE id = ?').run(milestone.done ? 0 : 1, milestone.id);
  recomputeProgress(goal.id);

  const anyDone = db.prepare('SELECT 1 FROM milestones m JOIN user_goals g ON g.id = m.goal_id WHERE g.user_id = ? AND m.done = 1 LIMIT 1').get(req.userId);
  if (anyDone) {
    db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(req.userId, 'first_milestone');
  }
  res.json({ goal: serializeGoal(db.prepare('SELECT * FROM user_goals WHERE id = ?').get(goal.id)) });
});

router.post('/mine/:categoryId/checkins', requireAuth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const goal = getOrCreateGoal(req.userId, req.params.categoryId);
  const id = nanoid();
  db.prepare('INSERT INTO checkins (id, goal_id, user_id, text) VALUES (?, ?, ?, ?)').run(id, goal.id, req.userId, text);

  db.prepare('UPDATE users SET goal_streak = goal_streak + 1 WHERE id = ?').run(req.userId);
  const streak = db.prepare('SELECT goal_streak FROM users WHERE id = ?').get(req.userId).goal_streak;
  if (streak >= 12) db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(req.userId, 'streak_12');
  if (streak >= 30) db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(req.userId, 'streak_30');

  res.status(201).json({ goal: serializeGoal(goal), goalStreak: streak });
});

router.post('/mine/:categoryId/cheer-squad', requireAuth, (req, res) => {
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });
  const goal = getOrCreateGoal(req.userId, req.params.categoryId);
  db.prepare('INSERT OR IGNORE INTO cheer_squad (goal_id, member_id) VALUES (?, ?)').run(goal.id, memberId);
  db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)').run(req.userId, 'squad_builder');
  res.status(201).json({ goal: serializeGoal(goal) });
});

router.get('/badges/mine', requireAuth, (req, res) => {
  const all = db.prepare('SELECT * FROM badges').all();
  const unlocked = new Set(db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?').all(req.userId).map(r => r.badge_id));
  res.json({ badges: all.map(b => ({ id: b.id, name: b.name, icon: b.icon, unlocked: unlocked.has(b.id) })) });
});

module.exports = router;
