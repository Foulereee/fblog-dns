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
    body: JSON.stringify({ from: SEND_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
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
  const subject = `【${PLATFORM_NAME}】你的注册验证码：${code}`;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<h2 style="color:#0f172a">验证你的邮箱</h2>' +
    `<p style="color:#334155">你在 ${esc(PLATFORM_NAME)} 提交了注册请求，验证码为：</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#0284c7;background:#f0f9ff;border:1px dashed #7dd3fc;border-radius:8px;padding:12px 16px;text-align:center">${esc(code)}</p>` +
    '<p style="color:#64748b;font-size:13px">验证码 10 分钟内有效，请勿泄露给他人。若非本人操作请忽略此邮件。</p>' +
    '</div>';
  const text = `你的 ${PLATFORM_NAME} 注册验证码是：${code}（10 分钟内有效）`;
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