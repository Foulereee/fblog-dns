/**
 * fblog.cyou 免费二级域名分发平台 - Worker 入口
 *
 * 公开页面：
 *   GET  /                         主页 / 管理面板（assets）
 * 认证：
 *   POST /api/register              邮箱注册 · 发送验证码
 *   POST /api/register/verify       邮箱注册 · 校验验证码并创建账号
 *   POST /api/login                 登录（用户名或邮箱 + 密码）
 *   POST /api/logout                退出
 *   GET  /api/me                    当前用户信息（含配额）
 * 记录管理：
 *   GET  /api/records               我的子域名列表（含到期/可续期状态）
 *   GET  /api/records/check         可用性检测（是否被占用）
 *   POST /api/records               创建 / 更新记录（A/AAAA/CNAME），1 年有效期
 *   POST /api/records/:id/renew     续期（剩余 <= 6 个月才可续）
 *   DELETE /api/records/:id         删除记录
 * 管理员：
 *   POST /api/admin/users           管理员建号（Bearer ADMIN_PASSWORD）
 *   POST /api/admin/maintenance     立即执行到期清理（Bearer ADMIN_PASSWORD）
 * 定时任务：
 *   scheduled (cron)                每日清理到期未续期的子域名
 */
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  safeEqual,
  EMAIL_RE,
  genEmailCode,
  hashEmailCode,
  usernameFromEmail,
} from './auth';
import { validateSubdomain, validateValue } from './validate';
import { CfDns } from './cloudflare';
import { EmailBinding, sendCodeEmail, sendExpiryReminder, sendResetCodeEmail } from './email';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL?: EmailBinding;
  RESEND_API_KEY?: string;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ROOT_DOMAIN: string;
}

const MAX_SUBDOMAINS_PER_USER = 2; // 每个用户最多 2 个子域名
const RECORD_LIFETIME_MS = 365 * 24 * 3600 * 1000; // 1 年
const RENEW_WINDOW_MS = 180 * 24 * 3600 * 1000; // 剩余 <= 6 个月时可续期
const CODE_TTL_MS = 10 * 60 * 1000; // 验证码 10 分钟
const CODE_RESEND_MS = 60 * 1000; // 重发间隔 60 秒
const CODE_DAILY_LIMIT = 5; // 每邮箱每日最多 5 次
const CODE_MAX_ATTEMPTS = 5; // 验证码最多尝试 5 次
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600; // 7 天

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- 简易内存限流（单边缘节点有效，生产建议叠加 Cloudflare Rate Limiting 规则） ----------
const attempts = new Map<string, { count: number; reset: number }>();

function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) {
      if (v.reset <= now) attempts.delete(k);
    }
  }
  const cur = attempts.get(key);
  if (!cur || cur.reset <= now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  cur.count += 1;
  return cur.count > limit;
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

// ---------- 工具函数 ----------
function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成 32 位随机 hex 令牌（DDNS 更新用） */
function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** dyndns2 风格纯文本响应（ddclient/路由器可解析） */
function ddnsText(body: string): Response {
  return new Response(body + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function ensureEnv(env: Env): void {
  const required: Array<[string, string | undefined]> = [
    ['CF_API_TOKEN', env.CF_API_TOKEN],
    ['CF_ZONE_ID', env.CF_ZONE_ID],
    ['SESSION_SECRET', env.SESSION_SECRET],
    ['ADMIN_PASSWORD', env.ADMIN_PASSWORD],
    ['ROOT_DOMAIN', env.ROOT_DOMAIN],
  ];
  const missing = required.filter(([, v]) => !v || !v.trim()).map(([k]) => k);
  if (missing.length > 0) {
    throw new HttpError(500, '服务端未配置完成，缺少环境变量: ' + missing.join(', '));
  }
}

interface SessionUser {
  id: number;
  username: string;
  email: string | null;
}

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = readCookie(request.headers.get('Cookie'));
  if (!token) throw new HttpError(401, '请先登录');
  const payload = await verifySessionToken(env.SESSION_SECRET, token);
  if (!payload) throw new HttpError(401, '登录已过期，请重新登录');
  const user = await env.DB.prepare('SELECT id, username, email, status FROM users WHERE id = ?1')
    .bind(payload.uid)
    .first<SessionUser & { status?: string }>();
  if (!user) throw new HttpError(401, '账号不存在');
  if (user.status === 'disabled') throw new HttpError(403, '账号已被禁用，请联系管理员');
  return { id: user.id, username: user.username, email: user.email ?? null };
}

/**
 * Cloudflare API 调用包装：给用户可读的错误信息（502 + 具体原因）。
 * 必须 return await，确保 rejection 在 try/catch 内被捕获。
 */
async function withCf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    throw new HttpError(502, `${label}失败：${msg}`);
  }
}

// ---------- 认证 ----------
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (rateLimited('login:' + clientIp(request), 10, 60_000)) {
    return json({ error: '尝试过于频繁，请一分钟后再试' }, 429);
  }
  const body = await readJson(request);
  const login = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!login || !password) return json({ error: '请输入用户名/邮箱和密码' }, 400);

  const user = await env.DB.prepare(
    'SELECT id, username, email, pass_hash, pass_salt, status FROM users WHERE username = ?1 OR email = ?1',
  )
    .bind(login)
    .first<{ id: number; username: string; email: string | null; pass_hash: string; pass_salt: string; status: string }>();
  if (!user || !(await verifyPassword(password, user.pass_salt, user.pass_hash))) {
    return json({ error: '用户名/邮箱或密码错误' }, 401);
  }
  if (user.status === 'disabled') return json({ error: '账号已被禁用，请联系管理员' }, 403);

  const token = await createSessionToken(env.SESSION_SECRET, {
    uid: user.id,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return json({ ok: true, username: user.username }, 200, {
    'Set-Cookie': setSessionCookie(token, SESSION_MAX_AGE_SECONDS),
  });
}

/** 注册第一步：用户名 + 邮箱 + 密码 → 发送验证码 */
async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (rateLimited('register:' + clientIp(request), 20, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return json({ error: '用户名需为 3-32 位小写字母、数字或下划线' }, 400);
  }
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return json({ error: '密码至少 8 位' }, 400);

  // 防重复注册：用户名与邮箱都唯一
  const dupName = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
  if (dupName) return json({ error: '该用户名已被占用，请换一个' }, 409);
  const dupEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (dupEmail) return json({ error: '该邮箱已注册，请直接登录或找回密码' }, 409);

  const row = await env.DB.prepare('SELECT sent_count, last_sent_at FROM reg_codes WHERE email = ?1')
    .bind(email)
    .first<{ sent_count: number; last_sent_at: number | null }>();
  const now = Date.now();
  if (row && row.last_sent_at && now - row.last_sent_at < CODE_RESEND_MS) {
    return json({ error: '发送过于频繁，请 60 秒后再试' }, 429);
  }
  if (row && row.sent_count >= CODE_DAILY_LIMIT) {
    return json({ error: '今日验证码发送次数已达上限，请明天再试' }, 429);
  }

  const code = genEmailCode();
  const codeHash = await hashEmailCode(code, email);
  const { hash, salt } = await hashPassword(password);
  const expiresAt = now + CODE_TTL_MS;

  if (row) {
    await env.DB.prepare(
      `UPDATE reg_codes SET code_hash = ?1, pass_hash = ?2, pass_salt = ?3, username = ?4, expires_at = ?5,
       attempts = 0, sent_count = sent_count + 1, last_sent_at = ?6 WHERE email = ?7`,
    )
      .bind(codeHash, hash, salt, username, expiresAt, now, email)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reg_codes (email, code_hash, pass_hash, pass_salt, username, expires_at, sent_count, last_sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
    )
      .bind(email, codeHash, hash, salt, username, expiresAt, now)
      .run();
  }

  const sent = await sendCodeEmail(env, email, code);
  if (!sent.delivered) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json(
      { error: '验证码发送失败：邮件服务尚未接入或发件域名未验证，请联系管理员' },
      502,
    );
  }
  return json({ ok: true, message: '验证码已发送到你的邮箱', email });
}

/** 注册第二步：校验验证码 → 创建账号并自动登录 */
async function handleRegisterVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const code = String(body?.code ?? '').trim();
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '验证码格式不正确' }, 400);

  const row = await env.DB.prepare(
    'SELECT code_hash, pass_hash, pass_salt, username, expires_at, attempts FROM reg_codes WHERE email = ?1',
  )
    .bind(email)
    .first<{ code_hash: string; pass_hash: string; pass_salt: string; username: string | null; expires_at: number; attempts: number }>();
  if (!row) return json({ error: '请先获取验证码' }, 400);
  if (!row.pass_hash || !row.pass_salt) return json({ error: '注册信息不完整，请重新获取验证码' }, 400);
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json({ error: '验证码已过期，请重新获取' }, 400);
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json({ error: '尝试次数过多，请重新获取验证码' }, 429);
  }

  const expect = await hashEmailCode(code, email);
  if (expect !== row.code_hash) {
    await env.DB.prepare('UPDATE reg_codes SET attempts = attempts + 1 WHERE email = ?1').bind(email).run();
    return json({ error: `验证码错误（还可尝试 ${Math.max(0, CODE_MAX_ATTEMPTS - row.attempts - 1)} 次）` }, 400);
  }

  // 用户名唯一性二次校验（防止两步之间被抢注）
  const username = (row.username ?? '').trim().toLowerCase() || usernameFromEmail(email);
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json({ error: '用户名不合法，请重新注册' }, 400);
  }
  const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ?1 OR email = ?2').bind(username, email).first();
  if (dup) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json({ error: '该用户名或邮箱已被占用，请重新注册' }, 409);
  }

  await env.DB.prepare(
    `INSERT INTO users (username, email, pass_hash, pass_salt, email_verified, status, created_via)
     VALUES (?1, ?2, ?3, ?4, 1, 'active', 'register')`,
  )
    .bind(username, email, row.pass_hash, row.pass_salt)
    .run();
  await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();

  const user = await env.DB.prepare('SELECT id, username FROM users WHERE email = ?1')
    .bind(email)
    .first<{ id: number; username: string }>();
  if (!user) return json({ error: '注册失败，请重试' }, 500);
  const token = await createSessionToken(env.SESSION_SECRET, {
    uid: user.id,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return json({ ok: true, username: user.username }, 200, {
    'Set-Cookie': setSessionCookie(token, SESSION_MAX_AGE_SECONDS),
  });
}

/** 找回密码第一步：邮箱 → 发送验证码 */
async function handleForgotPassword(request: Request, env: Env): Promise<Response> {
  if (rateLimited('forgot:' + clientIp(request), 10, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?1 AND email_verified = 1').bind(email).first();
  // 为防邮箱枚举，即使邮箱不存在也返回相同提示
  if (!user) return json({ ok: true, message: '若该邮箱已注册，验证码将发送至你的邮箱' });

  const row = await env.DB.prepare('SELECT sent_count, last_sent_at FROM reset_codes WHERE email = ?1')
    .bind(email)
    .first<{ sent_count: number; last_sent_at: number | null }>();
  const now = Date.now();
  if (row && row.last_sent_at && now - row.last_sent_at < CODE_RESEND_MS) {
    return json({ error: '发送过于频繁，请 60 秒后再试' }, 429);
  }
  if (row && row.sent_count >= CODE_DAILY_LIMIT) {
    return json({ error: '今日验证码发送次数已达上限，请明天再试' }, 429);
  }

  const code = genEmailCode();
  const codeHash = await hashEmailCode(code, email);
  const expiresAt = now + CODE_TTL_MS;
  if (row) {
    await env.DB.prepare(
      `UPDATE reset_codes SET code_hash = ?1, expires_at = ?2, attempts = 0, sent_count = sent_count + 1, last_sent_at = ?3 WHERE email = ?4`,
    )
      .bind(codeHash, expiresAt, now, email)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reset_codes (email, code_hash, expires_at, sent_count, last_sent_at) VALUES (?1, ?2, ?3, 1, ?4)`,
    )
      .bind(email, codeHash, expiresAt, now)
      .run();
  }

  const sent = await sendResetCodeEmail(env, email, code);
  if (!sent.delivered) {
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
    return json({ error: '验证码发送失败，请联系管理员' }, 502);
  }
  return json({ ok: true, message: '验证码已发送到你的邮箱', email });
}

/** 找回密码第二步：验证码 + 新密码 → 重置并自动登录 */
async function handleResetPassword(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const code = String(body?.code ?? '').trim();
  const newPassword = String(body?.password ?? '');
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '验证码格式不正确' }, 400);
  if (newPassword.length < 8) return json({ error: '密码至少 8 位' }, 400);

  const row = await env.DB.prepare(
    'SELECT code_hash, expires_at, attempts FROM reset_codes WHERE email = ?1',
  )
    .bind(email)
    .first<{ code_hash: string; expires_at: number; attempts: number }>();
  if (!row) return json({ error: '请先获取验证码' }, 400);
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
    return json({ error: '验证码已过期，请重新获取' }, 400);
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
    return json({ error: '尝试次数过多，请重新获取验证码' }, 429);
  }
  const expect = await hashEmailCode(code, email);
  if (expect !== row.code_hash) {
    await env.DB.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE email = ?1').bind(email).run();
    return json({ error: `验证码错误（还可尝试 ${Math.max(0, CODE_MAX_ATTEMPTS - row.attempts - 1)} 次）` }, 400);
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: number }>();
  if (!user) {
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
    return json({ error: '账号不存在' }, 404);
  }
  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3')
    .bind(hash, salt, user.id)
    .run();
  await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();

  const token = await createSessionToken(env.SESSION_SECRET, {
    uid: user.id,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return json({ ok: true, message: '密码已重置，已自动登录' }, 200, {
    'Set-Cookie': setSessionCookie(token, SESSION_MAX_AGE_SECONDS),
  });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const quota = await env.DB.prepare('SELECT COUNT(DISTINCT subdomain) AS n FROM records WHERE user_id = ?1')
    .bind(user.id)
    .first<{ n: number }>();
  return json({
    username: user.username,
    email: user.email,
    rootDomain: env.ROOT_DOMAIN,
    maxSubdomains: MAX_SUBDOMAINS_PER_USER,
    usedSubdomains: quota?.n ?? 0,
  });
}

// ---------- 记录管理 ----------
interface RecordRow {
  id: number;
  subdomain: string;
  type: string;
  value: string;
  expires_at: number | null;
  renewed_at: number | null;
  created_at: string;
  updated_at: string;
  ddns_token: string | null;
}

async function handleListRecords(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const res = await env.DB.prepare(
    `SELECT id, subdomain, type, value, expires_at, renewed_at, created_at, updated_at, ddns_token
     FROM records WHERE user_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<RecordRow>();
  const now = Date.now();
  const records = (res.results ?? []).map((r) => {
    const exp = r.expires_at ?? 0;
    const remaining = exp - now;
    return {
      id: r.id,
      subdomain: r.subdomain,
      type: r.type,
      value: r.value,
      created_at: r.created_at,
      expires_at: exp,
      days_remaining: Math.max(0, Math.floor(remaining / 86_400_000)),
      renewable: remaining > 0 && remaining <= RENEW_WINDOW_MS,
      expired: remaining <= 0,
      ddns_token: r.ddns_token ?? '',
    };
  });
  return json({ records, rootDomain: env.ROOT_DOMAIN, maxSubdomains: MAX_SUBDOMAINS_PER_USER });
}

/** 可用性检测：前缀是否可申请（公开接口，游客也可用；按 IP 限流防滥用） */
async function handleCheckRecord(request: Request, env: Env): Promise<Response> {
  if (rateLimited('check:' + clientIp(request), 60, 60_000)) {
    return json({ error: '检测过于频繁，请稍后再试' }, 429);
  }
  const url = new URL(request.url);
  const sub = (url.searchParams.get('subdomain') ?? '').trim().toLowerCase();
  if (!sub) return json({ available: false, reason: '请输入前缀', fqdn: '' });
  const err = validateSubdomain(sub);
  if (err) return json({ available: false, reason: err, fqdn: '' });
  const fqdn = `${sub}.${env.ROOT_DOMAIN}`;

  const local = await env.DB.prepare('SELECT id FROM records WHERE subdomain = ?1 LIMIT 1').bind(sub).first();
  if (local) return json({ available: false, reason: '该前缀已被其他用户占用', fqdn });

  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  const remote = await withCf('DNS 查询', () => cf.listByName(fqdn));
  if (remote.length > 0) return json({ available: false, reason: '该前缀在 DNS 中已被占用', fqdn });

  return json({ available: true, fqdn });
}

async function handleCreateRecord(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (rateLimited('create:' + user.id, 30, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }

  const body = await readJson(request);
  const sub = String(body?.subdomain ?? '').trim().toLowerCase();
  const type = String(body?.type ?? '').toUpperCase();
  const value = String(body?.value ?? '').trim();

  const err =
    validateSubdomain(sub) ??
    (type !== 'A' && type !== 'AAAA' && type !== 'CNAME'
      ? '记录类型仅支持 A / AAAA / CNAME'
      : null) ??
    validateValue(type, value, env.ROOT_DOMAIN);
  if (err) return json({ error: err }, 400);

  const fqdn = `${sub}.${env.ROOT_DOMAIN}`;

  // CNAME 与 A/AAAA 在同一前缀下互斥（DNS 规则），并防止占用他人前缀
  if (type === 'CNAME') {
    const other = await env.DB.prepare('SELECT id, user_id FROM records WHERE subdomain = ?1 AND type != ?2')
      .bind(sub, 'CNAME')
      .first<{ user_id: number }>();
    if (other) {
      return json(
        {
          error:
            other.user_id === user.id
              ? 'CNAME 不能与同一前缀下的 A/AAAA 记录共存，请先删除已有记录'
              : '该前缀已被其他用户占用',
        },
        409,
      );
    }
  } else {
    const cname = await env.DB.prepare('SELECT id, user_id FROM records WHERE subdomain = ?1 AND type = ?2')
      .bind(sub, 'CNAME')
      .first<{ user_id: number }>();
    if (cname) {
      return json(
        {
          error:
            cname.user_id === user.id
              ? '该前缀已有 CNAME 记录，无法再添加 A/AAAA 记录'
              : '该前缀已被其他用户占用',
        },
        409,
      );
    }
  }

  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);

  // 已有同前缀同类型记录 → 更新（保留原到期时间；仅限本人）
  const existing = await env.DB.prepare('SELECT id, user_id, cf_record_id FROM records WHERE subdomain = ?1 AND type = ?2')
    .bind(sub, type)
    .first<{ id: number; user_id: number; cf_record_id: string | null }>();
  if (existing) {
    if (existing.user_id !== user.id) {
      return json({ error: '该子域名已被其他用户占用' }, 409);
    }
    const rec = await withCf('DNS 更新', () =>
      cf.update(existing.cf_record_id ?? '', { type, name: fqdn, content: value }),
    );
    await env.DB.prepare(
      'UPDATE records SET value = ?1, cf_record_id = ?2, updated_at = ?3 WHERE id = ?4',
    )
      .bind(value, rec.id, new Date().toISOString(), existing.id)
      .run();
    return json({ ok: true, updated: true, fqdn, type, value });
  }

  // 全新子域名：配额检查（每用户 ≤ 2 个「不同前缀」）
  const quota = await env.DB.prepare('SELECT COUNT(DISTINCT subdomain) AS n FROM records WHERE user_id = ?1')
    .bind(user.id)
    .first<{ n: number }>();
  if ((quota?.n ?? 0) >= MAX_SUBDOMAINS_PER_USER) {
    return json(
      { error: `每个账号最多创建 ${MAX_SUBDOMAINS_PER_USER} 个子域名，请先删除一个再申请` },
      403,
    );
  }

  // 与平台外手工创建的记录冲突检测
  const remote = await withCf('DNS 查询', () => cf.listByName(fqdn));
  if (remote.length > 0) {
    return json({ error: '该子域名在 DNS 中已被占用（可能为平台外手工创建）' }, 409);
  }

  const rec = await withCf('DNS 写入', () => cf.create({ type, name: fqdn, content: value }));
  const expiresAt = Date.now() + RECORD_LIFETIME_MS;
  const ddnsToken = genToken();
  await env.DB.prepare(
    `INSERT INTO records (user_id, subdomain, type, value, cf_record_id, expires_at, ddns_token)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(user.id, sub, type, value, rec.id, expiresAt, ddnsToken)
    .run();
  return json({ ok: true, created: true, fqdn, type, value, expires_at: expiresAt, ddns_token: ddnsToken });
}

/** 续期：剩余 <= 6 个月时可续期，续期后重新计 1 年 */
async function handleRenewRecord(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/records\/(\d+)\/renew$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);

  const rec = await env.DB.prepare('SELECT id, subdomain, expires_at FROM records WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id)
    .first<{ id: number; subdomain: string; expires_at: number | null }>();
  if (!rec) return json({ error: '记录不存在或无权操作' }, 404);

  const now = Date.now();
  const exp = rec.expires_at ?? 0;
  const remaining = exp - now;
  if (remaining <= 0) {
    return json({ error: '该子域名已过期，无法续期' }, 400);
  }
  if (remaining > RENEW_WINDOW_MS) {
    return json({ error: '尚未到可续期时间（剩余超过 6 个月时不可提前续期）' }, 400);
  }

  const newExp = now + RECORD_LIFETIME_MS;
  await env.DB.prepare('UPDATE records SET expires_at = ?1, renewed_at = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(newExp, now, new Date().toISOString(), id)
    .run();
  return json({ ok: true, fqdn: `${rec.subdomain}.${env.ROOT_DOMAIN}`, expires_at: newExp });
}

async function handleDeleteRecord(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const id = Number(path.split('/').pop());
  if (!Number.isInteger(id)) return json({ error: '记录 ID 无效' }, 400);

  const rec = await env.DB.prepare('SELECT id, cf_record_id FROM records WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id)
    .first<{ id: number; cf_record_id: string | null }>();
  if (!rec) return json({ error: '记录不存在或无权操作' }, 404);

  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  try {
    await withCf('DNS 删除', () => cf.remove(rec.cf_record_id ?? ''));
  } catch (e) {
    // 远端记录可能已被删除，忽略并继续清理本地数据
    console.warn('Cloudflare 删除失败（继续清理本地）:', e);
  }
  await env.DB.prepare('DELETE FROM records WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

// ---------- DDNS 动态更新 ----------
/**
 * GET /api/ddns?token=xxx&ip=1.2.3.4
 * 无需登录，凭记录级 token 更新 IP（dyndns2 风格响应）：
 *   good <ip> / nochg <ip> / badauth / nohost / notfqdn / 911
 */
async function handleDDNS(request: Request, env: Env): Promise<Response> {
  if (rateLimited('ddns:' + clientIp(request), 60, 60_000)) {
    return ddnsText('911');
  }
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') ?? '').trim();
  const ipParam = (url.searchParams.get('ip') ?? '').trim();
  if (!token || token.length < 16) return ddnsText('badauth');

  const rec = await env.DB.prepare(
    'SELECT id, subdomain, type, value, cf_record_id, expires_at FROM records WHERE ddns_token = ?1',
  )
    .bind(token)
    .first<{ id: number; subdomain: string; type: string; value: string; cf_record_id: string | null; expires_at: number | null }>();
  if (!rec) return ddnsText('nohost');
  if (rec.expires_at !== null && rec.expires_at < Date.now()) return ddnsText('nohost');
  if (rec.type === 'CNAME') return ddnsText('notfqdn');

  const newIp = ipParam || request.headers.get('CF-Connecting-IP') || '';
  const err = validateValue(rec.type, newIp, env.ROOT_DOMAIN);
  if (err) return ddnsText('911');

  if (newIp === rec.value) return ddnsText(`nochg ${newIp}`);

  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  try {
    await cf.update(rec.cf_record_id ?? '', {
      type: rec.type,
      name: `${rec.subdomain}.${env.ROOT_DOMAIN}`,
      content: newIp,
    });
  } catch (e) {
    console.error('DDNS 更新失败:', e);
    return ddnsText('911');
  }
  await env.DB.prepare('UPDATE records SET value = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(newIp, new Date().toISOString(), rec.id)
    .run();
  return ddnsText(`good ${newIp}`);
}

/** 重置某条记录的 DDNS 令牌（需登录，仅本人） */
async function handleRegenDDNSToken(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/records\/(\d+)\/ddns-token$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const rec = await env.DB.prepare('SELECT id FROM records WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id)
    .first<{ id: number }>();
  if (!rec) return json({ error: '记录不存在或无权操作' }, 404);
  const token = genToken();
  await env.DB.prepare('UPDATE records SET ddns_token = ?1 WHERE id = ?2').bind(token, id).run();
  return json({ ok: true, ddns_token: token });
}

// ---------- 管理员 ----------
async function handleAdminCreateUser(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!safeEqual(auth, 'Bearer ' + env.ADMIN_PASSWORD)) {
    return json({ error: '无权操作' }, 401);
  }
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return json({ error: '用户名需为 3-32 位小写字母、数字或下划线' }, 400);
  }
  if (password.length < 8) {
    return json({ error: '密码至少 8 位' }, 400);
  }
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare('INSERT INTO users (username, pass_hash, pass_salt, created_via) VALUES (?1, ?2, ?3, ?4)')
      .bind(username, hash, salt, 'admin')
      .run();
  } catch {
    return json({ error: '用户名已存在' }, 409);
  }
  return json({ ok: true, username });
}

/** 立即执行到期清理（管理员手动触发 / 运维用，也便于测试） */
async function handleAdminMaintenance(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!safeEqual(auth, 'Bearer ' + env.ADMIN_PASSWORD)) {
    return json({ error: '无权操作' }, 401);
  }
  const released = await runExpiryCleanup(env);
  return json({ ok: true, released });
}

// ---------- 到期清理 ----------
async function runExpiryCleanup(env: Env): Promise<number> {
  const now = Date.now();
  const expired = await env.DB.prepare(
    'SELECT id, subdomain, cf_record_id FROM records WHERE expires_at IS NOT NULL AND expires_at < ?1',
  )
    .bind(now)
    .all<{ id: number; subdomain: string; cf_record_id: string | null }>();
  let n = 0;
  for (const rec of expired.results ?? []) {
    try {
      const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
      try {
        await cf.remove(rec.cf_record_id ?? '');
      } catch (e) {
        console.warn(`释放 ${rec.subdomain}: DNS 删除失败（继续清理本地）`, e);
      }
      await env.DB.prepare('DELETE FROM records WHERE id = ?1').bind(rec.id).run();
      n += 1;
      console.log(`[cleanup] 已释放到期子域名: ${rec.subdomain}.${env.ROOT_DOMAIN}`);
    } catch (e) {
      console.error('清理失败:', e);
    }
  }
  return n;
}

// ---------- 到期提醒（邮件） ----------
/** 对剩余 <=30 天（level 1）和 <=7 天（level 2）且未提醒过的记录各发一次邮件 */
async function runExpiryReminders(env: Env): Promise<number> {
  const day = 86_400_000;
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT r.id, r.subdomain, r.expires_at, r.reminder_level, u.email
     FROM records r JOIN users u ON u.id = r.user_id
     WHERE u.email IS NOT NULL AND u.email_verified = 1 AND r.expires_at IS NOT NULL`,
  ).all<{ id: number; subdomain: string; expires_at: number; reminder_level: number; email: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    const remain = r.expires_at - now;
    if (remain <= 0) continue; // 到期交给清理任务
    const days = Math.floor(remain / day);
    const level = r.reminder_level ?? 0;
    let next = level;
    try {
      if (days <= 7 && level < 2) {
        await sendExpiryReminder(env, r.email, r.subdomain, Math.max(days, 1));
        next = 2;
      } else if (days <= 30 && level < 1) {
        await sendExpiryReminder(env, r.email, r.subdomain, days);
        next = 1;
      } else {
        continue;
      }
      await env.DB.prepare('UPDATE records SET reminder_level = ?1 WHERE id = ?2').bind(next, r.id).run();
      n += 1;
    } catch (e) {
      console.error(`提醒发送失败 ${r.subdomain}:`, e);
    }
  }
  return n;
}

// ---------- 定时任务（每日 03:00 UTC） ----------
async function scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  try {
    const reminded = await runExpiryReminders(env);
    console.log(`[cron] 到期提醒发送 ${reminded} 封`);
    const released = await runExpiryCleanup(env);
    console.log(`[cron] 到期清理完成，释放 ${released} 个`);
  } catch (e) {
    console.error('[cron] 执行失败:', e);
  }
}

// ---------- 入口 ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
        return await env.ASSETS.fetch(request);
      }

      if (!path.startsWith('/api/')) {
        return json({ error: 'not found' }, 404);
      }

      ensureEnv(env);

      switch (path) {
        case '/api/login':
          return await handleLogin(request, env);
        case '/api/logout':
          return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
        case '/api/me':
          return await handleMe(request, env);
        case '/api/register':
          if (request.method === 'POST') return await handleRegister(request, env);
          break;
        case '/api/register/verify':
          if (request.method === 'POST') return await handleRegisterVerify(request, env);
          break;
        case '/api/password/forgot':
          if (request.method === 'POST') return await handleForgotPassword(request, env);
          break;
        case '/api/password/reset':
          if (request.method === 'POST') return await handleResetPassword(request, env);
          break;
        case '/api/records':
          if (request.method === 'GET') return await handleListRecords(request, env);
          if (request.method === 'POST') return await handleCreateRecord(request, env);
          break;
        case '/api/records/check':
          if (request.method === 'GET') return await handleCheckRecord(request, env);
          break;
        case '/api/ddns':
          // DDNS 动态更新：无需登录，凭 token 更新 IP（dyndns2 风格）
          if (request.method === 'GET') return await handleDDNS(request, env);
          break;
        case '/api/admin/users':
          if (request.method === 'POST') return await handleAdminCreateUser(request, env);
          break;
        case '/api/admin/maintenance':
          if (request.method === 'POST') return await handleAdminMaintenance(request, env);
          break;
      }

      if (path.startsWith('/api/records/') && path.endsWith('/renew') && request.method === 'POST') {
        return await handleRenewRecord(request, env, path);
      }
      if (path.startsWith('/api/records/') && path.endsWith('/ddns-token') && request.method === 'POST') {
        return await handleRegenDDNSToken(request, env, path);
      }
      if (path.startsWith('/api/records/') && request.method === 'DELETE') {
        return await handleDeleteRecord(request, env, path);
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      const err = e as { status?: unknown; message?: string; stack?: string };
      const isApi = request.url.includes('/api/');
      if (isApi) {
        if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) {
          return json({ error: err.message ?? '请求失败' }, err.status);
        }
        console.error('未处理异常:', e);
        return json({ error: '服务器内部错误' }, 500);
      }
      console.error('页面请求异常:', e);
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>页面加载失败</title>' +
          '<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:24px">' +
          '<h2>页面加载失败（HTTP 500）</h2><pre style="white-space:pre-wrap">' +
          escapeHtml(err?.message ?? String(e)) +
          '\n' +
          escapeHtml(err?.stack ?? '') +
          '</pre></body>',
        { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduled(event, env, ctx);
  },
};