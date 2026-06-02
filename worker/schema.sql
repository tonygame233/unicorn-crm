-- Unicorn CRM — D1 Schema (full)
-- Chạy bằng: wrangler d1 execute unicorn-crm-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sale',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '🤖',
  bot_token TEXT UNIQUE NOT NULL,
  bot_username TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  lifecycle TEXT DEFAULT 'New Lead',
  package TEXT,
  tags TEXT DEFAULT '[]',
  notes TEXT,
  sale TEXT,
  unread INTEGER DEFAULT 0,
  last_message TEXT,
  last_message_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME,
  language_code TEXT,
  is_premium INTEGER DEFAULT 0,
  phone TEXT,
  avatar_updated_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  text TEXT,
  type TEXT DEFAULT 'text',
  file_id TEXT,
  media_type TEXT,
  tg_msg_id INTEGER,
  bot_token TEXT,
  media_group_id TEXT,
  reply_to_msg_id INTEGER,
  direction TEXT NOT NULL,
  sender_name TEXT,
  reactions TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_cmd TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  files TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS archived_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER,
  contact_id INTEGER,
  channel_id INTEGER,
  telegram_chat_id INTEGER,
  tg_msg_id INTEGER,
  text TEXT,
  file_id TEXT,
  media_type TEXT,
  direction TEXT,
  sender_name TEXT,
  reactions TEXT,
  bot_token TEXT,
  media_group_id TEXT,
  deleted_by TEXT,
  original_created_at DATETIME,
  deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS track_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ref_code TEXT UNIQUE NOT NULL,
  channel_id INTEGER,
  click_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS track_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  contact_id INTEGER,
  telegram_id INTEGER,
  first_name TEXT,
  username TEXT,
  language_code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
