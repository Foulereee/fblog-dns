ALTER TABLE users ADD COLUMN email TEXT;

-- fblog.cyou 迁移脚本：在已有数据库上执行（幂等，可重复执行）
-- 在 Cloudflare Dashboard → Workers & Pages → D1 → fblog-dns-db → Console 中粘贴执行
--
-- ⚠️ 上面的语句必须放在文件最前面：D1 控制台粘贴时换行会被吃掉，
--    文件若以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。

-- 1) users 表：新增邮箱注册相关字段（首列见文件首行）
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN created_via TEXT NOT NULL DEFAULT 'admin';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2) 注册验证码表
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

-- 3) records 表：新增到期 / 续期字段，并把现有记录到期时间设为「现在 + 1 年」
ALTER TABLE records ADD COLUMN expires_at INTEGER;
ALTER TABLE records ADD COLUMN renewed_at INTEGER;
UPDATE records SET expires_at = CAST(strftime('%s','now') AS INTEGER) * 1000 + 31536000000 WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_records_expires ON records(expires_at);

-- 校验：SELECT name FROM sqlite_master WHERE type='table'; SELECT count(*) FROM records WHERE expires_at IS NULL;