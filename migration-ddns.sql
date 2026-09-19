ALTER TABLE records ADD COLUMN ddns_token TEXT;

-- fblog.cyou 迁移 3：DDNS 动态更新令牌 + 到期提醒等级
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行
-- （若报 duplicate column name，说明该列已存在，跳过对应行即可）
--
-- ⚠️ 上面的语句必须放在文件最前面：D1 控制台粘贴时换行会被吃掉，
--    文件若以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。

-- 1) records 表新增字段（续）
ALTER TABLE records ADD COLUMN reminder_level INTEGER NOT NULL DEFAULT 0;

-- 2) 给已有记录生成随机 DDNS 令牌（SQLite 内置随机函数）
UPDATE records SET ddns_token = lower(hex(randomblob(16))) WHERE ddns_token IS NULL;

-- 3) 校验
-- SELECT subdomain, ddns_token IS NOT NULL AS has_token FROM records;
-- PRAGMA table_info(records);