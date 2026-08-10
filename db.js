const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set. Add your Render PostgreSQL connection string as DATABASE_URL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  return pool.query(text, params);
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      website TEXT DEFAULT '',
      avatar_url TEXT DEFAULT NULL,
      goal_streak INTEGER DEFAULT 0,
      normal_streak INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (follower_id, followee_id)
    );

    CREATE TABLE IF NOT EXISTS goal_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES goal_categories(id) ON DELETE CASCADE,
      progress INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES user_goals(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES user_goals(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS badges (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_badges (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      unlocked_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, badge_id)
    );

    CREATE TABLE IF NOT EXISTS cheer_squad (
      goal_id TEXT NOT NULL REFERENCES user_goals(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (goal_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_mode TEXT NOT NULL CHECK(profile_mode IN ('goal','normal')),
      category_id TEXT,
      body TEXT NOT NULL,
      media_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS likes (
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      is_group INTEGER DEFAULT 0,
      name TEXT,
      pinned_message TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'text' CHECK(type IN ('text','gif','sticker')),
      text TEXT,
      reply_to_id TEXT,
      read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS live_streams (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_mode TEXT NOT NULL CHECK(profile_mode IN ('goal','normal')),
      title TEXT,
      status TEXT DEFAULT 'live' CHECK(status IN ('live','ended')),
      viewers INTEGER DEFAULT 0,
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS live_chat_messages (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_posts_mode ON posts(profile_mode, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  `);

  const catCount = await pool.query('SELECT COUNT(*) c FROM goal_categories');
  if (Number(catCount.rows[0].c) === 0) {
    const cats = ['Fitness', 'Career', 'Learning', 'Finance', 'Creative', 'Mindset'];
    for (const name of cats) {
      await pool.query('INSERT INTO goal_categories (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name.toLowerCase(), name]);
    }
  }

  const badgeCount = await pool.query('SELECT COUNT(*) c FROM badges');
  if (Number(badgeCount.rows[0].c) === 0) {
    const badges = [
      ['streak_12', '12-Day Streak', '🔥'],
      ['first_milestone', 'First Milestone', '🏁'],
      ['squad_builder', 'Squad Builder', '🤝'],
      ['checkins_100', '100 Check-ins', '💯'],
      ['goal_crusher', 'Goal Crusher', '🚀'],
      ['streak_30', '30-Day Streak', '🌙'],
    ];
    for (const [id, name, icon] of badges) {
      await pool.query('INSERT INTO badges (id, name, icon) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, name, icon]);
    }
  }
}

module.exports = { pool, query, initSchema };
