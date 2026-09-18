-- fblog.cyou 免费二级域名分发平台 - D1 数据库结构 v2（全新安装用）
-- 已有库请执行 migration-v2.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'user',
  github_star INTEGER NOT NULL DEFAULT 0,
  slots_extra INTEGER NOT NULL DEFAULT 0,
  created_via TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS reg_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  pass_hash TEXT,
  pass_salt TEXT,
  username TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);

CREATE TABLE IF NOT EXISTS reset_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);

-- 卡槽（用户拥有的二级域名）
CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  ddns_token TEXT,
  reminder_level INTEGER NOT NULL DEFAULT 0,
  -- 反代目标（用户自己的 Cloudflare Workers / Pages 地址）；NULL = 未开启反代
  proxy_target TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- DNS 记录（每卡槽 0..1 条）
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain_id INTEGER NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('A', 'AAAA', 'CNAME')),
  value TEXT NOT NULL,
  cf_record_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(subdomain_id)
);

-- 保留域名（管理员设定）
CREATE TABLE IF NOT EXISTS reserved_subdomains (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_subdomains_user ON subdomains(user_id);
CREATE INDEX IF NOT EXISTS idx_subdomains_expires ON subdomains(expires_at);