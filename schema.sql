-- fblog.cyou 免费二级域名分发平台 - D1 数据库结构（全新安装用）
-- 已有库请执行 migration.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_via TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 注册验证码（邮箱注册流程）
CREATE TABLE IF NOT EXISTS reg_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  pass_hash TEXT,
  pass_salt TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subdomain TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME')),
  value TEXT NOT NULL,
  cf_record_id TEXT,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (subdomain, type)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_records_user ON records(user_id);
CREATE INDEX IF NOT EXISTS idx_records_subdomain ON records(subdomain);
CREATE INDEX IF NOT EXISTS idx_records_expires ON records(expires_at);