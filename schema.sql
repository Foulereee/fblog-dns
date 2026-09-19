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

-- fblog.cyou 免费二级域名分发平台 - D1 数据库结构 v2（全新安装用）
-- 已有库请执行 migration-v2.sql
--
-- ⚠️ 说明：本文件把注释放在首条语句**之后**。D1 控制台粘贴时换行会被吃掉，
--    若文件以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。
--    （用 `wrangler d1 execute --file=` 执行则不受此影响。）

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
  -- 用户给该子域名起的备注（名字），纯整理用，不参与 DNS
  note TEXT,
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

-- 反代用量统计（按 UTC 天聚合，用于免费额度告警；Worker 内存按批汇总写入，近似值）
CREATE TABLE IF NOT EXISTS proxy_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  proxied INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 邮件通道当日用量（按 UTC 天 + 通道聚合，用于跳过已达免费额度的通道）
CREATE TABLE IF NOT EXISTS mail_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (day, provider)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_subdomains_user ON subdomains(user_id);
CREATE INDEX IF NOT EXISTS idx_subdomains_expires ON subdomains(expires_at);

-- 用户名 / 邮箱的**大小写不敏感**唯一约束。
-- 上面 users 表上的 UNIQUE 用的是 SQLite 默认的二进制比较，'Alice' 与 'alice' 会被
-- 当成两个不同的值。业务代码在写入前都做了 toLowerCase（注册、验证、管理端建号），
-- 所以正常情况下不会重复；这两个索引是数据库层的兜底，防止以后新增的写入路径漏掉归一化。
-- ⚠️ 若库里已存在大小写不同的重复数据，本语句会失败（UNIQUE constraint failed），
--    需先用 migration-lower-unique.sql 里的诊断语句查出并人工处理。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users(lower(email));