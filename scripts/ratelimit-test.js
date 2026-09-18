#!/usr/bin/env node
/**
 * 反代限流验证脚本
 *
 * 用途：确认反代限流真的会拦请求。**binding 被 Cloudflare 接受 ≠ 它在生效** ——
 * 必须实际打出 429 才算验证过。
 *
 * 用法：
 *   node scripts/ratelimit-test.js [总数] [并发] [主机名]
 *   node scripts/ratelimit-test.js 300 20 rl-test-9x.fblog.cyou
 *
 * ⚠️ 关键坑：官方限额的粒度是「**单个 Cloudflare 机房**」，不是全局。
 *    从一台机器发出的请求会被 anycast 分散到多个机房，每个机房各有一个独立计数桶，
 *    所以「总请求数 > limit」并不足以触发限流。
 *
 *    实测（2026-04，limit 临时压到 5/60s、内存兜底设为无效以便区分层次）：
 *      发出 60 次 → 36 次 404、24 次 429
 *    即约 7 个机房各放行了 5 次。生产值 limit=1200 时，
 *    单机压 1400 次（1400÷7 ≈ 每机房 200 次）**打不出 429**，属正常现象。
 *
 *    要想用生产限额稳定复现 429，需要让**单个机房**过 1200 次：
 *    提高总数与并发（如 6000 次 / 并发 100，注意会消耗当日 Worker 额度），
 *    或临时把 ratelimits.simple.limit 调小后重新部署。
 *
 * 建议用未注册的随机子域名做测试，避免影响真实用户的站点。
 */

const N = Number(process.argv[2] || 300);
const CONC = Number(process.argv[3] || 20);
const HOST = process.argv[4] || 'rl-test-9x.fblog.cyou';

const codes = Object.create(null);
let idx = 0;

async function one(i) {
  try {
    const r = await fetch(`https://${HOST}/?n=${i}`, { redirect: 'manual' });
    codes[r.status] = (codes[r.status] || 0) + 1;
    await r.arrayBuffer(); // 消费响应体，避免连接悬挂
  } catch (e) {
    const k = 'ERR:' + (e && e.cause && e.cause.code ? e.cause.code : e.message);
    codes[k] = (codes[k] || 0) + 1;
  }
}

async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= N) return;
    await one(i);
  }
}

(async () => {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const secs = (Date.now() - t0) / 1000;

  console.log(`主机 ${HOST}　发出 ${N} 次　并发 ${CONC}　耗时 ${secs.toFixed(1)} 秒`);
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(k).padEnd(18)} -> ${v} 次`));
  console.log(`  合计 ${total} 次`);

  const limited = codes['429'] || 0;
  if (limited > 0) {
    console.log(`✅ 限流已生效：${limited} 次被拦为 429`);
  } else {
    console.log('⚠️  未出现 429。这不一定是故障 —— 见文件顶部关于「按机房计数」的说明。');
    console.log('    若想确认限流可用，请临时调小 wrangler.jsonc 的 ratelimits.simple.limit 后重试。');
  }
})();