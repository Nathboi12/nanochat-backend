const Database = require('better-sqlite3');
require('dotenv').config();

const db = new Database(process.env.DB_PATH || './nanochat.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id),
  FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goal_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES goal_categories(id) ON DELETE CASCADE,
  UNIQUE(user_id, category_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  label TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  FOREIGN KEY (goal_id) REFERENCES user_goals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (goal_id) REFERENCES user_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS badges (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id TEXT NOT NULL,
  badge_id TEXT NOT NULL,
  unlocked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, badge_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (badge_id) REFERENCES badges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cheer_squad (
  goal_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (goal_id, member_id),
  FOREIGN KEY (goal_id) REFERENCES user_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  profile_mode TEXT NOT NULL CHECK(profile_mode IN ('goal','normal')),
  category_id TEXT,
  body TEXT NOT NULL,
  media_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  media_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  is_group INTEGER DEFAULT 0,
  name TEXT,
  pinned_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT DEFAULT 'text' CHECK(type IN ('text','gif','sticker')),
  text TEXT,
  reply_to_id TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS live_streams (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  profile_mode TEXT NOT NULL CHECK(profile_mode IN ('goal','normal')),
  title TEXT,
  status TEXT DEFAULT 'live' CHECK(status IN ('live','ended')),
  viewers INTEGER DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS live_chat_messages (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (stream_id) REFERENCES live_streams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_mode ON posts(profile_mode, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
`);

// Seed default goal categories + badge catalog if empty
const catCount = db.prepare('SELECT COUNT(*) c FROM goal_categories').get().c;
if (catCount === 0) {
  const insertCat = db.prepare('INSERT INTO goal_categories (id, name) VALUES (?, ?)');
  ['Fitness', 'Career', 'Learning', 'Finance', 'Creative', 'Mindset'].forEach(name => {
    insertCat.run(name.toLowerCase(), name);
  });
}
const badgeCount = db.prepare('SELECT COUNT(*) c FROM badges').get().c;
if (badgeCount === 0) {
  const insertBadge = db.prepare('INSERT INTO badges (id, name, icon) VALUES (?, ?, ?)');
  [
    ['streak_12', '12-Day Streak', '🔥'],
    ['first_milestone', 'First Milestone', '🏁'],
    ['squad_builder', 'Squad Builder', '🤝'],
    ['checkins_100', '100 Check-ins', '💯'],
    ['goal_crusher', 'Goal Crusher', '🚀'],
    ['streak_30', '30-Day Streak', '🌙'],
  ].forEach(([id, name, icon]) => insertBadge.run(id, name, icon));
}

module.exports = db;
