
    const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const NANO_SYSTEM_PROMPT = `You are GoalChat Coach, the AI heart of GoalChat — a personal progress and accountability platform.
Your mission is simple: help this person turn what they want into what they do.
You are their Goal Coach, Life Coach, Business Advisor, Startup Mentor, Career Coach, Study Partner,
Productivity Expert, Habit Builder, Accountability Partner, Writing Assistant, Creative Brainstorming
Partner, Financial Learning Coach, Wellness Coach, Communication Coach, and Leadership Mentor — all in one.

Always personalize using the user's real GoalChat profile data given to you below.
Never give generic advice if you can use their information instead.
Always encourage action. If a goal seems too large, break it into smaller steps.
If a user succeeds, celebrate them. If a user fails or misses a day, never shame them — help them
restart without guilt. Consistency over perfection. End with one clear, practical next action whenever appropriate.

Personality: intelligent, calm, honest, motivating, supportive, focused, positive — never preachy,
never a generic chatbot. Never exaggerate your abilities. If you don't know something, say so honestly
and help them find the best next step. Keep replies concise — 2-4 short sentences, mobile-friendly.`;

router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({ error: 'AI backend not configured', fallback: true });
    }
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message is required' });

    // Pull real profile context so replies are genuinely personalized, not generic.
    const userRes = await query('SELECT name, goal_streak, normal_streak, score FROM users WHERE id = $1', [req.userId]);
    const user = userRes.rows[0];
    const goalsRes = await query(
      `SELECT ug.title, ug.progress, ug.status,
              (SELECT COUNT(*) FROM milestones m WHERE m.goal_id = ug.id) as total_ms,
              (SELECT COUNT(*) FROM milestones m WHERE m.goal_id = ug.id AND m.done = 1) as done_ms
       FROM user_goals ug WHERE ug.user_id = $1 AND ug.status = 'active'`,
      [req.userId]
    );
    const goalsSummary = goalsRes.rows.length
      ? goalsRes.rows.map(g => `"${g.title}": ${g.progress}% (${g.done_ms}/${g.total_ms} milestones)`).join('; ')
      : 'No active goals yet';

    const contextBlock = `User's real GoalChat data — Name: ${user?.name || 'there'}, Goal streak: ${user?.goal_streak || 0} days, Score: ${user?.score || 0}. Active goals: ${goalsSummary}.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: NANO_SYSTEM_PROMPT + '\n\n' + contextBlock },
          { role: 'user', content: message.trim() },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI API error:', response.status, errText);
      return res.status(502).json({ error: 'AI service is unavailable right now.', fallback: true });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(502).json({ error: 'AI service returned an empty reply.', fallback: true });

    res.json({ reply });
  } catch (err) { next(err); }
});

module.exports = router;

  