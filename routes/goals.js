const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM goal_categories');
    res.json({ categories: rows });
  } catch (err) { next(err); }
});

async function getOrCreateGoal(userId, categoryId) {
  let { rows } = await query('SELECT * FROM user_goals WHERE user_id = $1 AND category_id = $2', [userId, categoryId]);
  if (!rows[0]) {
    const id = nanoid();
    await query('INSERT INTO user_goals (id, user_id, category_id) VALUES ($1, $2, $3)', [id, userId, categoryId]);
    ({ rows } = await query('SELECT * FROM user_goals WHERE id = $1', [id]));
  }
  return rows[0];
}

async function serializeGoal(goal) {
  const milestonesRes = await query('SELECT * FROM milestones WHERE goal_id = $1 ORDER BY position ASC', [goal.id]);
  const checkinsRes = await query(
    `SELECT c.id, c.text, c.created_at, u.name FROM checkins c JOIN users u ON u.id = c.user_id
     WHERE c.goal_id = $1 ORDER BY c.created_at DESC LIMIT 20`,
    [goal.id]
  );
  const cheerRes = await query(
    `SELECT u.id, u.name, u.avatar_url FROM cheer_squad cs JOIN users u ON u.id = cs.member_id WHERE cs.goal_id = $1`,
    [goal.id]
  );
  return {
    id: goal.id,
    categoryId: goal.category_id,
    description: goal.description || '',
    targetDate: goal.target_date,
    visibility: goal.visibility || 'public',
    progress: goal.progress,
    milestones: milestonesRes.rows.map(m => ({ id: m.id, label: m.label, description: m.description || '', targetDate: m.target_date, done: !!m.done })),
    checkins: checkinsRes.rows.map(c => ({ id: c.id, text: c.text, who: c.name, createdAt: c.created_at })),
    cheerSquad: cheerRes.rows.map(m => ({ id: m.id, name: m.name, avatarUrl: m.avatar_url })),
  };
}

router.get('/mine/:categoryId', requireAuth, async (req, res, next) => {
  try {
    const goal = await getOrCreateGoal(req.userId, req.params.categoryId);
    res.json({ goal: await serializeGoal(goal) });
  } catch (err) { next(err); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM user_goals WHERE user_id = $1', [req.userId]);
    const goals = [];
    for (const g of rows) goals.push(await serializeGoal(g));
    res.json({ goals });
  } catch (err) { next(err); }
});

// Edit goal (description, target date, visibility)
router.patch('/mine/:categoryId', requireAuth, async (req, res, next) => {
  try {
    const { description, targetDate, visibility } = req.body;
    if (visibility && !['public', 'followers', 'private'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be public, followers, or private' });
    }
    const goal = await getOrCreateGoal(req.userId, req.params.categoryId);
    await query(
      'UPDATE user_goals SET description = COALESCE($1, description), target_date = $2, visibility = COALESCE($3, visibility) WHERE id = $4',
      [description, targetDate || null, visibility, goal.id]
    );
    const { rows } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(rows[0]) });
  } catch (err) { next(err); }
});

// Delete goal (and its milestones/checkins/cheer squad via ON DELETE CASCADE)
router.delete('/mine/:categoryId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM user_goals WHERE user_id = $1 AND category_id = $2', [req.userId, req.params.categoryId]);
    if (!rows[0]) return res.status(404).json({ error: 'Goal not found' });
    await query('DELETE FROM user_goals WHERE id = $1', [rows[0].id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/mine/:categoryId/milestones', requireAuth, async (req, res, next) => {
  try {
    const { label, description, targetDate } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });
    const goal = await getOrCreateGoal(req.userId, req.params.categoryId);
    const id = nanoid();
    const posRes = await query('SELECT COUNT(*) c FROM milestones WHERE goal_id = $1', [goal.id]);
    await query(
      'INSERT INTO milestones (id, goal_id, label, description, target_date, position) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, goal.id, label, description || '', targetDate || null, Number(posRes.rows[0].c)]
    );
    res.status(201).json({ goal: await serializeGoal(goal) });
  } catch (err) { next(err); }
});

async function recomputeProgress(goalId) {
  const { rows } = await query('SELECT done FROM milestones WHERE goal_id = $1', [goalId]);
  if (rows.length === 0) { await query('UPDATE user_goals SET progress = 0 WHERE id = $1', [goalId]); return; }
  const done = rows.filter(m => m.done).length;
  const progress = Math.round((done / rows.length) * 100);
  await query('UPDATE user_goals SET progress = $1 WHERE id = $2', [progress, goalId]);
}

async function assertMilestoneOwner(milestoneId, userId) {
  const { rows: mRows } = await query('SELECT * FROM milestones WHERE id = $1', [milestoneId]);
  const milestone = mRows[0];
  if (!milestone) return { error: 404 };
  const { rows: gRows } = await query('SELECT * FROM user_goals WHERE id = $1', [milestone.goal_id]);
  const goal = gRows[0];
  if (!goal || goal.user_id !== userId) return { error: 403 };
  return { milestone, goal };
}

router.patch('/milestones/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const { milestone, goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });

    await query('UPDATE milestones SET done = $1 WHERE id = $2', [milestone.done ? 0 : 1, milestone.id]);
    await recomputeProgress(goal.id);

    const anyDone = await query(
      'SELECT 1 FROM milestones m JOIN user_goals g ON g.id = m.goal_id WHERE g.user_id = $1 AND m.done = 1 LIMIT 1',
      [req.userId]
    );
    if (anyDone.rows[0]) {
      await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'first_milestone']);
    }
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});

// Edit milestone (label, description, target date)
router.patch('/milestones/:id', requireAuth, async (req, res, next) => {
  try {
    const { milestone, goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });

    const { label, description, targetDate } = req.body;
    await query(
      'UPDATE milestones SET label = COALESCE($1, label), description = COALESCE($2, description), target_date = $3 WHERE id = $4',
      [label, description, targetDate || null, milestone.id]
    );
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});

// Delete milestone
router.delete('/milestones/:id', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });

    await query('DELETE FROM milestones WHERE id = $1', [req.params.id]);
    await recomputeProgress(goal.id);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});

router.post('/mine/:categoryId/checkins', requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
    const goal = await getOrCreateGoal(req.userId, req.params.categoryId);
    const id = nanoid();
    await query('INSERT INTO checkins (id, goal_id, user_id, text) VALUES ($1, $2, $3, $4)', [id, goal.id, req.userId, text]);

    await query('UPDATE users SET goal_streak = goal_streak + 1 WHERE id = $1', [req.userId]);
    const streakRes = await query('SELECT goal_streak FROM users WHERE id = $1', [req.userId]);
    const streak = streakRes.rows[0].goal_streak;
    if (streak >= 12) await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'streak_12']);
    if (streak >= 30) await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'streak_30']);

    res.status(201).json({ goal: await serializeGoal(goal), goalStreak: streak });
  } catch (err) { next(err); }
});

router.post('/mine/:categoryId/cheer-squad', requireAuth, async (req, res, next) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });
    const goal = await getOrCreateGoal(req.userId, req.params.categoryId);
    await query('INSERT INTO cheer_squad (goal_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [goal.id, memberId]);
    await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'squad_builder']);
    res.status(201).json({ goal: await serializeGoal(goal) });
  } catch (err) { next(err); }
});

router.get('/badges/mine', requireAuth, async (req, res, next) => {
  try {
    const all = await query('SELECT * FROM badges');
    const unlocked = await query('SELECT badge_id FROM user_badges WHERE user_id = $1', [req.userId]);
    const unlockedSet = new Set(unlocked.rows.map(r => r.badge_id));
    res.json({ badges: all.rows.map(b => ({ id: b.id, name: b.name, icon: b.icon, unlocked: unlockedSet.has(b.id) })) });
  } catch (err) { next(err); }
});

module.exports = router;
