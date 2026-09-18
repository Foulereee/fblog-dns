// 临时压测脚本：验证反代限流是否真的会返回 429
// 用法: node .tmp-ratelimit-test.js [总数] [并发] [主机前缀]
const N = Number(process.argv[2] || 1400);
const CONC = Number(process.argv[3] || 40);
const HOST = process.argv[4] || 'rl-test-9x.fblog.cyou';

const codes = Object.create(null);
let idx = 0;

async function one(i) {
  const url = `https://${HOST}/?n=${i}`;
  try {
    const r = await fetch(url, { redirect: 'manual' });
    codes[r.status] = (codes[r.status] || 0) + 1;
    await r.arrayBuffer(); // 消费掉响应体，避免连接悬挂
  } catch (e) {
    const k = 'ERR:' + (e && e.cause && e.cause.code ? e.cause.code : e.message);
    codes[k] = (codes[k] || 0) + 1;
  }
}

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= N) return;
    await one(i);
  }
}

(async () => {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const secs = (Date.now() - t0) / 1000;
  console.log(`主机 ${HOST}  发出 ${N} 次请求  并发 ${CONC}  耗时 ${secs.toFixed(1)} 秒`);
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${String(k).padEnd(18)} -> ${v} 次`));
  console.log(`  合计 ${total} 次`);
  const limited = codes['429'] || 0;
  console.log(limited > 0 ? `✅ 限流已生效：${limited} 次被拦为 429` : '❌ 未观察到 429');
})();