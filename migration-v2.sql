ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';

-- fblog.cyou v2 迁移：卡槽模型 + 管理员 + 保留域名
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行（先备份；测试数据可清）
-- 说明：将旧的「一条记录=一个域名」改为「卡槽(subdomains) + 记录(records)」分离
--
-- ⚠️ 上面的语句必须放在文件最前面：D1 控制台粘贴时换行会被吃掉，
--    文件若以 -- 注释开头，整段都会变成注释并报 incomplete input: SQLITE_ERROR。

-- 1) users 增加角色与卡槽字段（首列见文件首行）
ALTER TABLE users ADD COLUMN github_star INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN slots_extra INTEGER NOT NULL DEFAULT 0;

-- 1.1) 提升现有 admin 账号为管理员
UPDATE users SET role = 'admin' WHERE username = 'admin';

-- 2) 旧 records 表改名，腾出名字
ALTER TABLE records RENAME TO records_old;

-- 3) 新「卡槽」表
CREATE TABLE IF NOT EXISTS subdomains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER,
  ddns_token TEXT,
  reminder_level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subdomains_user ON subdomains(user_id);
CREATE INDEX IF NOT EXISTS idx_subdomains_expires ON subdomains(expires_at);

-- 4) 新「记录」表（每卡槽 0..1 条 DNS 记录）
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain_id INTEGER NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('A','AAAA','CNAME')),
  value TEXT NOT NULL,
  cf_record_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(subdomain_id)
);

-- 5) 迁移旧数据：每个旧 subdomain → 一个卡槽 + 一条记录（取最早的记录）
INSERT INTO subdomains (user_id, name, expires_at, renewed_at, ddns_token, reminder_level, created_at, updated_at)
SELECT user_id, subdomain, COALESCE(expires_at, CAST(strftime('%s','now') AS INTEGER)*1000 + 31536000000),
       renewed_at, ddns_token, reminder_level, created_at, updated_at
FROM records_old
WHERE id IN (SELECT MIN(id) FROM records_old GROUP BY subdomain);

INSERT INTO records (subdomain_id, type, value, cf_record_id, created_at, updated_at)
SELECT s.id, o.type, o.value, o.cf_record_id, o.created_at, o.updated_at
FROM records_old o JOIN subdomains s ON s.name = o.subdomain
WHERE o.id IN (SELECT MIN(id) FROM records_old GROUP BY subdomain);

-- 6) 保留域名表
CREATE TABLE IF NOT EXISTS reserved_subdomains (
  name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 校验（可选）：
-- SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- SELECT count(*) AS subdomains FROM subdomains;
-- SELECT count(*) AS records FROM records;
