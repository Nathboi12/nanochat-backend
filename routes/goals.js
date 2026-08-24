
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

async function serializeGoal(goal) {
  const milestonesRes = await query('SELECT * FROM milestones WHERE goal_id = $1 ORDER BY position ASC', [goal.id]);
  const milestones = [];
  for (const m of milestonesRes.rows) {
    const tasksRes = await query('SELECT * FROM tasks WHERE milestone_id = $1 ORDER BY position ASC', [m.id]);
    milestones.push({
      id: m.id, label: m.label, description: m.description || '', targetDate: m.target_date, done: !!m.done,
      tasks: tasksRes.rows.map(t => ({ id: t.id, title: t.title, description: t.description || '', estimatedMinutes: t.estimated_minutes, done: !!t.done })),
    });
  }
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
    title: goal.title,
    categoryId: goal.category_id,
    description: goal.description || '',
    difficulty: goal.difficulty || '',
    availableTime: goal.available_time || '',
    status: goal.status,
    targetDate: goal.target_date,
    visibility: goal.visibility || 'public',
    progress: goal.progress,
    createdAt: goal.created_at,
    milestones,
    checkins: checkinsRes.rows.map(c => ({ id: c.id, text: c.text, who: c.name, createdAt: c.created_at })),
    cheerSquad: cheerRes.rows.map(m => ({ id: m.id, name: m.name, avatarUrl: m.avatar_url })),
  };
}

// List all of my goals (no longer limited to fixed categories)
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM user_goals WHERE user_id = $1 AND status != 'archived' ORDER BY created_at DESC", [req.userId]);
    const goals = [];
    for (const g of rows) goals.push(await serializeGoal(g));
    res.json({ goals });
  } catch (err) { next(err); }
});

// Single goal
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM user_goals WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Goal not found' });
    if (rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your goal' });
    res.json({ goal: await serializeGoal(rows[0]) });
  } catch (err) { next(err); }
});

// Create a real custom goal
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { title, description, categoryId, targetDate, difficulty, availableTime, visibility } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (visibility && !['public', 'followers', 'private'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be public, followers, or private' });
    }
    const id = nanoid();
    await query(
      `INSERT INTO user_goals (id, user_id, title, category_id, description, target_date, difficulty, available_time, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.userId, title.trim(), categoryId || null, description || '', targetDate || null, difficulty || '', availableTime || '', visibility || 'public']
    );
    await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'first_goal']);
    const { rows } = await query('SELECT * FROM user_goals WHERE id = $1', [id]);
    res.status(201).json({ goal: await serializeGoal(rows[0]) });
  } catch (err) { next(err); }
});

async function assertGoalOwner(goalId, userId) {
  const { rows } = await query('SELECT * FROM user_goals WHERE id = $1', [goalId]);
  const goal = rows[0];
  if (!goal) return { error: 404 };
  if (goal.user_id !== userId) return { error: 403 };
  return { goal };
}

// Edit goal
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertGoalOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Goal not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });

    const { title, description, categoryId, targetDate, difficulty, availableTime, visibility, status } = req.body;
    if (visibility && !['public', 'followers', 'private'].includes(visibility)) {
      return res.status(400).json({ error: 'visibility must be public, followers, or private' });
    }
    if (status && !['active', 'completed', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'status must be active, completed, or archived' });
    }
    await query(
      `UPDATE user_goals SET
         title = COALESCE($1, title), description = COALESCE($2, description),
         category_id = $3, target_date = $4, difficulty = COALESCE($5, difficulty),
         available_time = COALESCE($6, available_time), visibility = COALESCE($7, visibility),
         status = COALESCE($8, status)
       WHERE id = $9`,
      [title, description, categoryId !== undefined ? categoryId : goal.category_id, targetDate !== undefined ? targetDate : goal.target_date,
       difficulty, availableTime, visibility, status, goal.id]
    );
    if (status === 'completed') {
      await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'goal_crusher']);
    }
    const { rows } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(rows[0]) });
  } catch (err) { next(err); }
});

// Delete goal
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { error } = await assertGoalOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Goal not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    await query('DELETE FROM user_goals WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// --- Milestones ---
router.post('/:id/milestones', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertGoalOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Goal not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { label, description, targetDate } = req.body;
    if (!label) return res.status(400).json({ error: 'label is required' });
    const id = nanoid();
    const posRes = await query('SELECT COUNT(*) c FROM milestones WHERE goal_id = $1', [goal.id]);
    await query('INSERT INTO milestones (id, goal_id, label, description, target_date, position) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, goal.id, label, description || '', targetDate || null, Number(posRes.rows[0].c)]);
    res.status(201).json({ goal: await serializeGoal(goal) });
  } catch (err) { next(err); }
});

async function assertMilestoneOwner(milestoneId, userId) {
  const { rows: mRows } = await query('SELECT * FROM milestones WHERE id = $1', [milestoneId]);
  const milestone = mRows[0];
  if (!milestone) return { error: 404 };
  const { rows: gRows } = await query('SELECT * FROM user_goals WHERE id = $1', [milestone.goal_id]);
  const goal = gRows[0];
  if (!goal || goal.user_id !== userId) return { error: 403 };
  return { milestone, goal };
}

async function recomputeProgress(goalId) {
  // Progress now considers tasks where they exist, falling back to milestone completion otherwise.
  const msRes = await query('SELECT id, done FROM milestones WHERE goal_id = $1', [goalId]);
  if (msRes.rows.length === 0) { await query('UPDATE user_goals SET progress = 0 WHERE id = $1', [goalId]); return; }

  let totalUnits = 0, doneUnits = 0;
  for (const m of msRes.rows) {
    const tRes = await query('SELECT done FROM tasks WHERE milestone_id = $1', [m.id]);
    if (tRes.rows.length > 0) {
      totalUnits += tRes.rows.length;
      doneUnits += tRes.rows.filter(t => t.done).length;
    } else {
      totalUnits += 1;
      doneUnits += m.done ? 1 : 0;
    }
  }
  const progress = totalUnits ? Math.round((doneUnits / totalUnits) * 100) : 0;
  await query('UPDATE user_goals SET progress = $1 WHERE id = $2', [progress, goalId]);
  if (progress >= 100) {
    await query("UPDATE user_goals SET status = 'completed' WHERE id = $1 AND status = 'active'", [goalId]);
  }
}

router.patch('/milestones/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const { milestone, goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    await query('UPDATE milestones SET done = $1 WHERE id = $2', [milestone.done ? 0 : 1, milestone.id]);
    await recomputeProgress(goal.id);
    await query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, 'first_milestone']);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});
router.patch('/milestones/:id', requireAuth, async (req, res, next) => {
  try {
    const { milestone, goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { label, description, targetDate } = req.body;
    await query('UPDATE milestones SET label = COALESCE($1, label), description = COALESCE($2, description), target_date = $3 WHERE id = $4',
      [label, description, targetDate || null, milestone.id]);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});
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

// --- Tasks (live under milestones — the real "Today's Action" building blocks) ---
router.post('/milestones/:id/tasks', requireAuth, async (req, res, next) => {
  try {
    const { milestone, goal, error } = await assertMilestoneOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Milestone not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { title, description, estimatedMinutes } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const id = nanoid();
    const posRes = await query('SELECT COUNT(*) c FROM tasks WHERE milestone_id = $1', [milestone.id]);
    await query('INSERT INTO tasks (id, milestone_id, title, description, estimated_minutes, position) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, milestone.id, title, description || '', estimatedMinutes || null, Number(posRes.rows[0].c)]);
    await recomputeProgress(goal.id);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.status(201).json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});

async function assertTaskOwner(taskId, userId) {
  const { rows: tRows } = await query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const task = tRows[0];
  if (!task) return { error: 404 };
  const { milestone, goal, error } = await assertMilestoneOwner(task.milestone_id, userId);
  if (error) return { error };
  return { task, milestone, goal };
}

router.patch('/tasks/:id/toggle', requireAuth, async (req, res, next) => {
  try {
    const { task, goal, error } = await assertTaskOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Task not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    await query('UPDATE tasks SET done = $1 WHERE id = $2', [task.done ? 0 : 1, task.id]);
    await recomputeProgress(goal.id);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});
router.patch('/tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const { task, goal, error } = await assertTaskOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Task not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { title, description, estimatedMinutes } = req.body;
    await query('UPDATE tasks SET title = COALESCE($1, title), description = COALESCE($2, description), estimated_minutes = $3 WHERE id = $4',
      [title, description, estimatedMinutes !== undefined ? estimatedMinutes : task.estimated_minutes, task.id]);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});
router.delete('/tasks/:id', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertTaskOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Task not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    await query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    await recomputeProgress(goal.id);
    const { rows: freshGoal } = await query('SELECT * FROM user_goals WHERE id = $1', [goal.id]);
    res.json({ goal: await serializeGoal(freshGoal[0]) });
  } catch (err) { next(err); }
});

// --- Today's Action: the single most important endpoint in GoalChat ---
// Picks the next incomplete task across the user's active goals (oldest goal first, in order).
router.get('/today/action', requireAuth, async (req, res, next) => {
  try {
    const { rows: goals } = await query("SELECT * FROM user_goals WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC", [req.userId]);
    for (const goal of goals) {
      const { rows: milestones } = await query('SELECT * FROM milestones WHERE goal_id = $1 AND done = 0 ORDER BY position ASC', [goal.id]);
      for (const m of milestones) {
        const { rows: tasks } = await query('SELECT * FROM tasks WHERE milestone_id = $1 AND done = 0 ORDER BY position ASC LIMIT 1', [m.id]);
        if (tasks[0]) {
          return res.json({
            task: { id: tasks[0].id, title: tasks[0].title, description: tasks[0].description, estimatedMinutes: tasks[0].estimated_minutes },
            milestone: { id: m.id, label: m.label },
            goal: { id: goal.id, title: goal.title, progress: goal.progress },
          });
        }
      }
    }
    res.json({ task: null }); // nothing left to do — either no goals, or everything's complete
  } catch (err) { next(err); }
});

// --- Check-ins ---
router.post('/:id/checkins', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertGoalOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Goal not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });
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

// --- Cheer Squad ---
router.post('/:id/cheer-squad', requireAuth, async (req, res, next) => {
  try {
    const { goal, error } = await assertGoalOwner(req.params.id, req.userId);
    if (error === 404) return res.status(404).json({ error: 'Goal not found' });
    if (error === 403) return res.status(403).json({ error: 'Not your goal' });
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });
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
