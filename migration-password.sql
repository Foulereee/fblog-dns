ALTER TABLE reg_codes ADD COLUMN username TEXT;

-- fblog.cyou 迁移 4：找回密码 + 注册自定义用户名
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行
-- 若某行报 duplicate column name，说明已执行过，跳过即可
--
-- ⚠️ 上面的语句必须放在文件最前面：D1 控制台粘贴时换行会被吃掉，
--    文件若以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。

-- 1) 注册验证码表：新增 username 字段（用户注册时自定义用户名）—— 见文件首行

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