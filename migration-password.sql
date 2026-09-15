-- fblog.cyou 迁移 4：找回密码 + 注册自定义用户名
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行
-- 若某行报 duplicate column name，说明已执行过，跳过即可

-- 1) 注册验证码表：新增 username 字段（用户注册时自定义用户名）
ALTER TABLE reg_codes ADD COLUMN username TEXT;

-- 2) 找回密码验证码表
CREATE TABLE IF NOT EXISTS reset_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);

-- 校验：SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reset_codes','reg_codes');
-- PRAGMA table_info(reg_codes);