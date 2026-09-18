-- fblog.cyou 迁移 6：反向代理用量统计（用于免费额度告警）
--
-- 为什么需要：反代把全站子域名流量都引到了平台自己的 Worker 上，吃的是平台的
-- Workers 免费额度（100,000 请求/天，午夜 UTC 重置）。额度跑满时 Cloudflare 会
-- 返回 1027；若该路由为 fail open，请求会被绕过 Worker 直接回源到占位地址 100::，
-- 结果是**所有反代站点一起 522**。所以必须能提前看到用量。
--
-- 计数器在 Worker 内存里累加，按批（默认每 200 次请求或每 60 秒）汇总写一张表，
-- 把 D1 写放大压到 0.5% 以内。因此这里是**近似值**：isolate 被回收时未落盘的计数
-- 会丢失，实际用量通常略高于表中数字。作为告警信号足够。
--
-- 在 Cloudflare Dashboard → D1 → fblog-dns-db → Console 中粘贴执行。

CREATE TABLE IF NOT EXISTS proxy_usage (
  day        TEXT PRIMARY KEY,          -- UTC 日期 YYYY-MM-DD
  requests   INTEGER NOT NULL DEFAULT 0, -- 反代分发处理的请求总数
  proxied    INTEGER NOT NULL DEFAULT 0, -- 其中成功转发到用户目标的
  limited    INTEGER NOT NULL DEFAULT 0, -- 其中被限流拦下的
  alerted    INTEGER NOT NULL DEFAULT 0, -- 是否已就该日发过额度告警（0/1）
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 校验
-- SELECT * FROM proxy_usage ORDER BY day DESC LIMIT 7;