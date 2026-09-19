CREATE TABLE IF NOT EXISTS mail_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (day, provider)
);

-- ↑ 语句必须放在文件最前面：D1 控制台粘贴时换行会被吃掉，
--   若文件以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。

-- 邮件多通道：记录各通道（resend / brevo / cloudflare）的当日发信量。
--
--   day      UTC 日期（YYYY-MM-DD），与各家的"自然日重置"对齐
--   sent     当天通过该通道成功发出的封数
--   failed   当天该通道尝试失败的次数
--
-- 这个表只影响"优化"：当天额度用完后直接跳过该通道，省掉一次必然失败的请求。
-- 表不存在时发信功能照常工作，只是不做跳过判断（代码里已 try/catch 兜住）。
--
-- 建表后查看最近用量：
--   SELECT day, provider, sent, failed FROM mail_usage ORDER BY day DESC, provider LIMIT 30;