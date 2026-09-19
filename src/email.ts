/**
 * 邮件发送模块（多通道，按顺序自动降级）
 * ---------------------------------------------------------------------------
 * 免费邮件服务的日配额都很小（Resend 100/天），单靠一家很容易被注册量打满。
 * 这里把「往哪发」抽象成一串通道，按顺序依次尝试，前面失败/超额就自动用下一家，
 * 从而把可用额度叠加起来。
 *
 * 默认顺序（可用 env.MAIL_PROVIDERS 覆盖，逗号分隔）：
 *   resend     → RESEND_API_KEY     免费 100 封/天
 *   brevo      → BREVO_API_KEY      免费 300 封/天
 *   cloudflare → EMAIL binding      Cloudflare Email Service，额度按信誉动态放宽
 *   都没有 / 都失败 → 降级为 console 输出（本地开发可见验证码）
 *
 * 关于「日配额」：
 *   cap 是各家的**免费额度**，写死在这里，用于当天用量达到上限后直接跳过该通道，
 *   不再浪费一次失败请求（否则每次都要等对方返回 429）。
 *   实际用量记在 D1 的 mail_usage 表（按 UTC 天 + 通道）。
 *   ⚠️ 计数是「尽力而为」：写失败只记录日志，绝不阻断发信；表不存在时自动跳过计数。
 *
 * 发送域名：mail.fblog.cyou（每家都需各自验证该域名，DNS 记录加在 Cloudflare）
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
  /** 用于记录各通道当日用量；缺失时不做计数（功能不受影响） */
  DB?: D1Database;
  EMAIL?: EmailBinding;
  RESEND_API_KEY?: string;
  BREVO_API_KEY?: string;
  /** 覆盖通道顺序，如 "brevo,resend"；只发这两家，cloudflare 不参与 */
  MAIL_PROVIDERS?: string;
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

/** 各通道共用：解析响应体，失败时打日志并返回 false（不抛，避免打断降级链） */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail = (data?.message ?? data?.error ?? '') as string;
      console.error(`${label} 发送失败: HTTP ${res.status} ${detail}`);
      return { ok: false, data };
    }
    return { ok: true, data };
  } catch (e) {
    console.error(`${label} 请求异常:`, (e as { message?: string }).message ?? e);
    return { ok: false, data: null };
  }
}

// ---------------------------------------------------------------------------
// 各通道
// ---------------------------------------------------------------------------

/** Resend（免费 100 封/天）。成功响应带 id。 */
async function sendViaResend(env: EmailEnv, msg: MailMsg): Promise<boolean> {
  const key = env.RESEND_API_KEY;
  if (!key) return false;
  const { ok, data } = await postJson(
    'https://api.resend.com/emails',
    { Authorization: `Bearer ${key}` },
    { from: `${PLATFORM_NAME} <${SEND_FROM}>`, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text },
    'Resend',
  );
  // Resend 即使 200 也可能只返回错误对象，必须确认拿到 id
  return ok && Boolean(data?.id);
}

/**
 * Brevo（免费 300 封/天）
 * 文档：POST https://api.brevo.com/v3/smtp/email
 *   header: api-key
 *   body:   { sender:{email,name}, to:[{email}], subject, htmlContent, textContent }
 *   成功:   201 { messageId }
 */
async function sendViaBrevo(env: EmailEnv, msg: MailMsg): Promise<boolean> {
  const key = env.BREVO_API_KEY;
  if (!key) return false;
  const { ok, data } = await postJson(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': key },
    {
      sender: { email: SEND_FROM, name: PLATFORM_NAME },
      to: [{ email: msg.to }],
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
    },
    'Brevo',
  );
  return ok && Boolean(data?.messageId);
}

/**
 * Cloudflare Email Service（send_email binding）
 * ⚠️ 前置条件：必须在控制台把发件域名接入 Email Service —— 未接入时只能发给
 *    「已验证的目标地址」，发给普通用户会抛错（这里会被捕获并降级到下一家）。
 * 官方限额说明：新账号从一个保守的日配额起步，随投递信誉自动放宽，没有固定数字。
 */
async function sendViaCloudflare(env: EmailEnv, msg: MailMsg): Promise<boolean> {
  if (!env.EMAIL?.send) return false;
  try {
    await env.EMAIL.send({ to: msg.to, from: SEND_FROM, subject: msg.subject, html: msg.html, text: msg.text });
    return true;
  } catch (e) {
    console.error('Cloudflare Email Service 发送失败:', (e as { code?: string }).code, (e as { message?: string }).message);
    return false;
  }
}

interface Provider {
  name: string;
  label: string;
  /** 免费日配额；0 = 未知/不设限（只记录用量，不做跳过判断） */
  cap: number;
  ready: (env: EmailEnv) => boolean;
  send: (env: EmailEnv, msg: MailMsg) => Promise<boolean>;
}

const PROVIDERS: Provider[] = [
  { name: 'resend', label: 'Resend', cap: 100, ready: (e) => Boolean(e.RESEND_API_KEY), send: sendViaResend },
  { name: 'brevo', label: 'Brevo', cap: 300, ready: (e) => Boolean(e.BREVO_API_KEY), send: sendViaBrevo },
  { name: 'cloudflare', label: 'Cloudflare', cap: 0, ready: (e) => Boolean(e.EMAIL?.send), send: sendViaCloudflare },
];

/** 当前生效的通道（顺序）。MAIL_PROVIDERS 未设置时用默认全量顺序。 */
function resolveProviders(env: EmailEnv): Provider[] {
  const raw = (env.MAIL_PROVIDERS ?? '').trim();
  if (!raw) return PROVIDERS;
  const want = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return want.map((n) => PROVIDERS.find((p) => p.name === n)).filter((p): p is Provider => Boolean(p));
}

/** 供管理端展示：当前生效的通道顺序与各自配额 */
export function activeProviders(env: EmailEnv): { name: string; label: string; cap: number }[] {
  return resolveProviders(env).map((p) => ({ name: p.name, label: p.label, cap: p.cap }));
}

// ---------------------------------------------------------------------------
// 当日用量计数（D1，尽力而为）
// ---------------------------------------------------------------------------

export interface MailUsage {
  day: string;
  rows: { provider: string; sent: number; failed: number }[];
  providers: { name: string; label: string; cap: number; ready: boolean; sent: number; failed: number }[];
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadUsage(env: EmailEnv, day: string): Promise<Map<string, { sent: number; failed: number }>> {
  const map = new Map<string, { sent: number; failed: number }>();
  if (!env.DB) return map;
  try {
    const r = await env.DB.prepare('SELECT provider, sent, failed FROM mail_usage WHERE day = ?1')
      .bind(day)
      .all<{ provider: string; sent: number; failed: number }>();
    for (const row of r.results ?? []) map.set(row.provider, { sent: row.sent, failed: row.failed });
  } catch {
    // mail_usage 表还没建（未执行迁移）→ 不计数，但不影响发信
  }
  return map;
}

async function bumpUsage(env: EmailEnv, day: string, provider: string, ok: boolean): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      `INSERT INTO mail_usage (day, provider, sent, failed) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(day, provider) DO UPDATE SET
         sent = sent + excluded.sent,
         failed = failed + excluded.failed,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
      .bind(day, provider, ok ? 1 : 0, ok ? 0 : 1)
      .run();
  } catch (e) {
    console.error('mail_usage 写入失败（不影响发信）:', (e as { message?: string }).message ?? e);
  }
}

/** 管理端用：今天的各通道用量与配额 */
export async function getMailUsage(env: EmailEnv): Promise<MailUsage> {
  const day = utcDay();
  const usage = await loadUsage(env, day);
  return {
    day,
    rows: [...usage.entries()].map(([provider, u]) => ({ provider, sent: u.sent, failed: u.failed })),
    providers: PROVIDERS.map((p) => ({
      name: p.name,
      label: p.label,
      cap: p.cap,
      ready: p.ready(env),
      sent: usage.get(p.name)?.sent ?? 0,
      failed: usage.get(p.name)?.failed ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// 发送入口
// ---------------------------------------------------------------------------

export interface SendResult {
  delivered: boolean;
  provider: string;
  /** 依次尝试过的通道及结果（便于排查「为什么没收到」） */
  tried: string[];
}

/** 统一发送入口：按顺序尝试各通道，全部失败则降级为 console 输出 */
async function sendMail(env: EmailEnv, msg: MailMsg): Promise<SendResult> {
  const day = utcDay();
  const usage = await loadUsage(env, day);
  const tried: string[] = [];

  for (const p of resolveProviders(env)) {
    if (!p.ready(env)) continue;

    // 当日用量已达免费额度 → 直接跳过，省掉一次必然失败的请求
    if (p.cap > 0 && (usage.get(p.name)?.sent ?? 0) >= p.cap) {
      tried.push(`${p.name}:已达当日免费额度 ${p.cap}`);
      continue;
    }

    if (await p.send(env, msg)) {
      await bumpUsage(env, day, p.name, true);
      return { delivered: true, provider: p.name, tried };
    }
    await bumpUsage(env, day, p.name, false);
    tried.push(`${p.name}:发送失败`);
  }

  console.error(`[DEV-EMAIL] 所有邮件通道均不可用\n主题=${msg.subject}\n收件人=${msg.to}\n正文=${msg.text}`);
  return { delivered: false, provider: 'dev-log', tried };
}

/**
 * 管理端用：通过指定通道（或第一个可用通道）发一封测试邮件。
 * 用于新增密钥后立刻确认该通道能否真正投递 —— 未接入的通道不必猜。
 */
export async function sendTestEmail(env: EmailEnv, to: string, providerName?: string): Promise<SendResult> {
  const subject = 'fblog.cyou 邮件通道测试';
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    `<p style="color:#334155">这是一封来自 ${esc(PLATFORM_NAME)} 的通道测试邮件。</p>` +
    '<p style="color:#334155">能收到，说明该邮件通道工作正常。</p>' +
    `<p style="color:#64748b;font-size:13px">发送时间（UTC）：${new Date().toISOString()}</p>` +
    '</div>';
  const text = `${PLATFORM_NAME} 邮件通道测试 —— 能收到即说明通道正常。时间（UTC）：${new Date().toISOString()}`;
  const msg: MailMsg = { to, subject, html, text };

  if (!providerName) return sendMail(env, msg);

  const p = PROVIDERS.find((x) => x.name === providerName.trim().toLowerCase());
  if (!p) return { delivered: false, provider: providerName, tried: [`未知通道 ${providerName}`] };
  if (!p.ready(env)) return { delivered: false, provider: p.name, tried: [`${p.name}:未配置密钥`] };
  const ok = await p.send(env, msg);
  await bumpUsage(env, utcDay(), p.name, ok);
  return { delivered: ok, provider: p.name, tried: ok ? [] : [`${p.name}:发送失败`] };
}

// ---------------------------------------------------------------------------
// 业务邮件
// ---------------------------------------------------------------------------

/** 发送验证码邮件 */
export async function sendCodeEmail(env: EmailEnv, to: string, code: string): Promise<SendResult> {
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
export async function sendResetCodeEmail(env: EmailEnv, to: string, code: string): Promise<SendResult> {
  const subject = `fblog.cyou 重置密码 ${code}`;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
    '<p style="color:#334155">你好，</p>' +
    '<p style="color:#334155">你正在重置密码，验证码为：</p>' +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#0284c7;background:#f0f9ff;border:1px dashed #7dd3fc;border-radius:8px;padding:12px 16px;text-align:center">${esc(code)}</p>` +
    '<p style="color:#64748b;font-size:13px">验证码 10 分钟内有效。若非本人操作，请忽略这封邮件。</p>' +
    '</div>';
  const text = `你正在重置 ${PLATFORM_NAME} 的密码，验证码：${code}（10 分钟内有效）。若非本人操作请忽略。`;
  return sendMail(env, { to, subject, html, text });
}

/** 发送到期提醒 */
export async function sendExpiryReminder(
  env: EmailEnv,
  to: string,
  items: { name: string; expiresAt: number; level: number }[],
): Promise<void> {
  if (items.length === 0) return;
  const level = items[0].level;
  const title = level >= 2 ? '你的子域名即将到期' : '你的子域名进入了续期窗口';
  const subject = `${title}（${items.length} 个）`;
  const rows = items
    .map((it) => {
      const d = Math.max(0, Math.ceil((it.expiresAt - Date.now()) / 86400000));
      return `<tr><td style="padding:4px 12px 4px 0"><code>${esc(it.name)}</code></td><td style="padding:4px 0;color:#b45309">剩余 ${d} 天</td></tr>`;
    })
    .join('');
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">' +
    `<p style="color:#334155">你好，以下 ${items.length} 个子域名快到有效期了：</p>` +
    `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` +
    '<p style="color:#334155">登录平台，在「我的子域名」里点「续期」即可延长 1 年，免费。</p>' +
    '<p style="color:#64748b;font-size:13px">到期未续期会被自动释放，前缀将重新开放给其他用户申请，且无法找回。</p>' +
    '</div>';
  const text =
    `${items.length} 个子域名快到有效期了：\n` +
    items.map((it) => `  ${it.name}（剩余 ${Math.max(0, Math.ceil((it.expiresAt - Date.now()) / 86400000))} 天）`).join('\n') +
    `\n\n登录 ${'https://dns.fblog.cyou'} 点「续期」即可延长 1 年（免费）。到期未续期会被自动释放且无法找回。`;
  await sendMail(env, { to, subject, html, text });
}

/** 发送用量告警（Workers 免费额度） */
export async function sendUsageAlert(
  env: EmailEnv,
  to: string,
  stats: { day: string; requests: number; proxied: number; limited: number; threshold: number },
): Promise<void> {
  const pct = Math.round((stats.requests / stats.threshold) * 100);
  const subject = `[告警] 反代请求数已达阈值 ${pct}%`;
  const html =
    '<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">' +
    `<p style="color:#b45309;font-weight:600">${esc(stats.day)}（UTC）反代请求数已达告警阈值 ${stats.threshold} 的 ${pct}%。</p>` +
    '<table style="border-collapse:collapse;font-size:14px">' +
    `<tr><td style="padding:4px 12px 4px 0">今日请求</td><td>${stats.requests}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">成功转发</td><td>${stats.proxied}</td></tr>` +
    `<tr><td style="padding:4px 12px 4px 0">被限流</td><td>${stats.limited}</td></tr>` +
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