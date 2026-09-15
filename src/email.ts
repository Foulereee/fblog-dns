/**
 * 邮件发送模块
 *
 * 使用 Cloudflare Email Service 的 send_email binding（env.EMAIL.send），
 * 无需第三方邮件服务。发送域名需在 Cloudflare 控制台接入 Email Service
 * 并完成验证（见 DEPLOY.md），默认发件人 noreply@mail.fblog.cyou。
 *
 * 本地开发（未配置 binding / 绑定不可用）时降级为 console 输出验证码，
 * 便于在终端里看到验证码。
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

export const SEND_FROM = 'noreply@mail.fblog.cyou';
export const PLATFORM_NAME = 'fblog.cyou 二级域名分发平台';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 发送验证码邮件。
 * @param envEnv 包含可选 EMAIL binding 的环境对象
 */
export async function sendCodeEmail(
  env: { EMAIL?: EmailBinding },
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

  if (env.EMAIL?.send) {
    try {
      await env.EMAIL.send({ to, from: SEND_FROM, subject, html, text });
      return { delivered: true, provider: 'cloudflare-email-service' };
    } catch (e) {
      // 发送失败（如发件域名未验证）：记录并降级
      console.error('邮件发送失败:', (e as { code?: string; message?: string }).code, (e as { message?: string }).message);
    }
  }
  // 本地开发 / 未接入邮件服务：把验证码打到日志
  console.error(`[DEV-EMAIL] 验证码 for ${to} = ${code}`);
  return { delivered: false, provider: 'dev-log' };
}

/** 到期提醒邮件（到期前 7 天） */
export async function sendExpiryReminder(
  env: { EMAIL?: EmailBinding },
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
  if (env.EMAIL?.send) {
    try {
      await env.EMAIL.send({ to, from: SEND_FROM, subject, html, text });
    } catch (e) {
      console.error('到期提醒邮件发送失败:', (e as { message?: string }).message);
    }
  }
}