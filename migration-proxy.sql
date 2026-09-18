-- fblog.cyou 迁移 5：子域名反代
-- 用途：让用户把 xxx.fblog.cyou 指向自己的 Cloudflare Workers / Pages
--       （用户在自己的账号部署 Worker，这里只登记它的 *.workers.dev / *.pages.dev 地址）
--
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行。
-- 若已执行过会报 duplicate column，跳过该行即可。

-- 1) subdomains 表新增反代目标（NULL = 未开启反代）
ALTER TABLE subdomains ADD COLUMN proxy_target TEXT;

-- 2) 不做任何数据回填：已有卡槽默认不走反代，行为完全不变。

-- 3) 校验
-- PRAGMA table_info(subdomains);
-- SELECT name, proxy_target FROM subdomains WHERE proxy_target IS NOT NULL;