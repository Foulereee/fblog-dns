/**
 * 邮件发送模块（多通道）
 *
 * 优先级：
 *   1) env.RESEND_API_KEY 存在 → 走 Resend（免费 100 封/天，REST API）
 *   2) env.EMAIL（Cloudflare Email Service send_email binding）→ 走 Cloudflare
 *   3) 都没有 → 降级为 console 输出（本地开发 / 未接入任何服务时可见验证码）
 *
 * 发送域名：mail.fblog.cyou（Resend 需要验证该域名，DNS 记录加在 Cloudflare）
 * 默认发件人：noreply@mail.fblog.cyou
 */

export interface EmailBinding {
  send(message: {
    to: string | { email: string; name?: string };
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export interface EmailEnv {
  EMAIL?: EmailBinding;
  RESEND_API_KEY?: string;
}

export const SEND_FROM = 'noreply@mail.fblog.cyou';
export const PLATFORM_NAME = 'fblog.cyou 二级域名分发平台';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface MailMsg {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** 通过 Resend 发送 */
async function sendViaResend(env: EmailEnv, msg: MailMsg): Promise<boolean> {
  const key = env.RESEND_API_KEY;
  if (!key) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${PLATFORM_NAME} <${SEND_FROM}>`,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  const data = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
  if (!res.ok) {
    console.error('Resend 发送失败:', res.status, data?.message ?? '');
    return false;
  }
  return Boolean(data?.id);
}

/** 通过 Cloudflare Email Service binding 发送 */
async function sendViaCloudflare(env: EmailEnv, msg: MailMsg): Promise<boolean> {
  if (!env.EMAIL?.send) return false;
  try {
    await env.EMAIL.send({ to: msg.to, from: SEND_FROM, subject: msg.subject, html: msg.html, text: msg.text });
    return true;
  } catch (e) {
    console.error('Cloudflare Email Service 发送失败:', (e as { code?: string; message?: string }).code, (e as { message?: string }).message);
    return false;
  }
}

/** 统一发送入口：Resend → Cloudflare → dev-log */
async function sendMail(env: EmailEnv, msg: MailMsg): Promise<{ delivered: boolean; provider: string }> {
  if (await sendViaResend(env, msg)) return { delivered: true, provider: 'resend' };
  if (await sendViaCloudflare(env, msg)) return { delivered: true, provider: 'cloudflare-email-service' };
  console.error(`[DEV-EMAIL] 主题=${msg.subject}\n收件人=${msg.to}\n正文=${msg.text}`);
  return { delivered: false, provider: 'dev-log' };
}

/**
 * 发送验证码邮件。
 */
export async function sendCodeEmail(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<{ delivered: boolean; provider: string }> {
  const subject = `fblog.cyou 邮箱验证 ${code}`;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<p style="color:#334155">你好，</p>' +
    `<p style="color:#334155">你正在 ${esc(PLATFORM_NAME)} 验证邮箱，验证码为：</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#0284c7;background:#f0f9ff;border:1px dashed #7dd3fc;border-radius:8px;padding:12px 16px;text-align:center">${esc(code)}</p>` +
    '<p style="color:#64748b;font-size:13px">验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。</p>' +
    '</div>';
  const text = `你正在 ${PLATFORM_NAME} 验证邮箱，验证码：${code}（10 分钟内有效）。若非本人操作请忽略。`;
  return sendMail(env, { to, subject, html, text });
}

/** 发送找回密码验证码 */
export async function sendResetCodeEmail(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<{ delivered: boolean; provider: string }> {
  const subject = `fblog.cyou 找回密码 ${code}`;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<p style="color:#334155">你好，</p>' +
    `<p style="color:#334155">你正在重置 ${esc(PLATFORM_NAME)} 的账号密码，验证码为：</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#0284c7;background:#f0f9ff;border:1px dashed #7dd3fc;border-radius:8px;padding:12px 16px;text-align:center">${esc(code)}</p>` +
    '<p style="color:#64748b;font-size:13px">验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。</p>' +
    '</div>';
  const text = `你正在重置 ${PLATFORM_NAME} 的账号密码，验证码：${code}（10 分钟内有效）。若非本人操作请忽略。`;
  return sendMail(env, { to, subject, html, text });
}

/** 到期提醒邮件（到期前 N 天） */
export async function sendExpiryReminder(
  env: EmailEnv,
  to: string,
  subdomain: string,
  daysLeft: number,
): Promise<void> {
  const subject = `【${PLATFORM_NAME}】子域名 ${subdomain}.fblog.cyou 即将到期`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">` +
    `<h2 style="color:#0f172a">子域名即将到期</h2>` +
    `<p style="color:#334155">你的子域名 <b>${esc(subdomain)}.fblog.cyou</b> 将在 <b>${daysLeft}</b> 天后到期。</p>` +
    `<p style="color:#334155">到期前（剩余不超过 6 个月时）可登录平台一键续期；到期未续期将自动释放该子域名。</p>` +
    `<p style="color:#64748b;font-size:13px">登录 https://dns.fblog.cyou 查看并续期。</p>` +
    `</div>`;
  const text = `你的子域名 ${subdomain}.fblog.cyou 将在 ${daysLeft} 天后到期，请登录 https://dns.fblog.cyou 及时续期。`;
  await sendMail(env, { to, subject, html, text });
}

/**
 * 反代用量的额度告警（每日最多一封）。
 *
 * 背景：反代把全站子域名流量都引到平台自己的 Worker 上，吃平台账号的 Workers
 * 免费额度（100,000 请求/天）。额度跑满时 Cloudflare 返回 1027；若该路由为
 * fail open，请求会绕过 Worker 回源到占位地址 100::，结果是所有反代站点一起 522。
 * 所以要在跑满之前就收到通知。
 */
export async function sendUsageAlert(
  env: EmailEnv,
  to: string,
  stats: { day: string; requests: number; proxied: number; limited: number; threshold: number },
): Promise<void> {
  const pct = Math.round((stats.requests / stats.threshold) * 100);
  const subject = `【${PLATFORM_NAME}】反代用量告警：已达阈值 ${pct}%`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">` +
    `<h2 style="color:#b45309">反代用量接近免费额度上限</h2>` +
    `<p style="color:#334155">${esc(stats.day)}（UTC）的反向代理请求数已经达到告警阈值：</p>` +
    `<table style="border-collapse:collapse;font-size:14px;color:#334155">` +
    `<tr><td style="padding:4px 12px 4px 0">今日请求数</td><td><b>${stats.requests}</b></td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">其中成功转发</td><td>${stats.proxied}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">其中被限流拦截</td><td>${stats.limited}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">告警阈值</td><td>${stats.threshold}</td></tr>` +
    `</table>` +
    `<p style="color:#334155">Workers 免费额度为 <b>100,000 请求/天</b>（午夜 UTC 重置）。` +
    `一旦跑满，Cloudflare 会返回错误 1027；若该路由是 fail open，请求将绕过 Worker 回源到占位地址 <code>100::</code>，` +
    `<b>所有反代站点会一起返回 522</b>。</p>` +
    `<p style="color:#334155">处理方式：升级到 Workers Paid（$5/月起，含 1000 万请求/月）；` +
    `或到管理面板排查是哪个子域名在吃额度。</p>` +
    `<p style="color:#64748b;font-size:13px">此为自动发送的用量告警，每个 UTC 日最多一封。` +
    `数字来自 Worker 内存按批汇总，是近似值（实际用量通常略高）。</p>` +
    `</div>`;
  const text =
    `${stats.day}（UTC）反代请求数已达告警阈值 ${stats.threshold} 的 ${pct}%。\n` +
    `今日请求 ${stats.requests}（成功转发 ${stats.proxied}，被限流 ${stats.limited}）。\n` +
    `Workers 免费额度 100,000 请求/天；跑满后所有反代站点会一起 522。\n` +
    `处理：升级 Workers Paid（$5/月起），或到 dns.fblog.cyou 管理面板排查。\n` +
    `（数字为内存批量汇总的近似值，实际通常略高。）`;
  await sendMail(env, { to, subject, html, text });
}