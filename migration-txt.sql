CREATE TABLE IF NOT EXISTS slot_txt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subdomain_id INTEGER NOT NULL REFERENCES subdomains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  cf_record_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(subdomain_id, name)
);

CREATE INDEX IF NOT EXISTS idx_slot_txt_subdomain ON slot_txt(subdomain_id);

-- 附加 TXT 记录表（卡槽的域名归属校验等用途）
--
-- 为什么单独一张表而不是给 records.type 加 'TXT'：
-- records 是「每卡槽 0..1 条」，而校验类 TXT 需要与主记录**同时存在** ——
-- 典型场景是卡槽设了 CNAME 指向阿里云 ESA，同时还要有 _esaauth 的 TXT
-- 供 ESA 验证域名归属权。塞进 records 会互相顶掉。
--
-- name 由服务端强制以 `_` 开头（如 _esaauth / _acme-challenge）：
-- 下划线前缀不是合法主机名，因此不可能与卡槽的主记录或其他用户的
-- 子域名冲突，也不能用来冒充真实主机名。
-- 实际 FQDN = `<name>.<卡槽名>.<根域名>`，例如 _esaauth.blog.fblog.cyou
--
-- ⚠️ 本文件把注释放在首条语句**之后**。D1 控制台粘贴时换行会被吃掉，
--    若以 -- 注释开头，整段会变成注释并报 incomplete input: SQLITE_ERROR。
--
-- 全新安装不需要执行本文件（schema.sql 已包含）；已有库执行一次即可。
-- 不执行也不会报错：发信/解析等主流程不受影响，只是 TXT 相关接口不可用。