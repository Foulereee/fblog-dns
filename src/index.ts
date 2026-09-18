/**
 * fblog.cyou 免费二级域名分发平台 - Worker 入口 v2
 *
 * 卡槽模型：用户「申请子域名」得到一个卡槽（slot），随后可「使用」它设置一条 DNS 记录。
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
import { validateSubdomain, validateValue, validateProxyTarget, normalizeProxyTarget } from './validate';
import { CfDns } from './cloudflare';
import { EmailBinding, sendCodeEmail, sendExpiryReminder, sendResetCodeEmail, sendUsageAlert } from './email';

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
  /**
   * 除 dns / www 外，还要当成「平台自身入口」（走平台界面、不参与反代）的子域名前缀，
   * 逗号分隔。用于避开通配路由抢走本 zone 内其它 Worker 自定义域名的副作用。
   */
  PLATFORM_HOSTS?: string;
  /**
   * 「透传」前缀，逗号分隔。命中的子域名不参与反代，而是把原始请求 `fetch()` 出去 ——
   * 子请求不会被路由拦截，会直达该主机名**自定义域名**背后的那个 Worker。
   *
   * 用途：通配路由按官方规则优先级高于自定义域名，会抢走本 zone 内其它 Worker 的
   * 自定义域名；把它的前缀登记到这里即可原样还给对方。
   */
  PASSTHROUGH_HOSTS?: string;
  /** 反代限流 binding（wrangler.jsonc 的 ratelimits）。缺失时退回内存计数兜底。 */
  RATE_LIMITER?: RateLimit;
  /** name → 卡槽 的内存缓存 TTL，单位秒；"0" 关闭。 */
  PROXY_CACHE_TTL?: string;
  /** 内存限流兜底用的每分钟上限。 */
  RATE_LIMIT_PER_MIN?: string;
  /** 当日反代请求数超过该值时给管理员发告警邮件。 */
  USAGE_ALERT_THRESHOLD?: string;
}

const BASE_SLOTS = 1; // 免费基础卡槽
const MAX_SLOTS = 5; // 卡槽上限
const RECORD_LIFETIME_MS = 365 * 24 * 3600 * 1000; // 1 年
const RENEW_WINDOW_MS = 180 * 24 * 3600 * 1000; // 剩余 <= 6 个月可续期
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const CODE_DAILY_LIMIT = 5;
const CODE_MAX_ATTEMPTS = 5;
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
const LAUNCH_MS = Date.UTC(2026, 8, 14); // 运营起始日 2026-09-14

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function genToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function ddnsText(body: string): Response {
  return new Response(body + '\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
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
  role: string;
  github_star: number | null;
  slots_extra: number | null;
}

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = readCookie(request.headers.get('Cookie'));
  if (!token) throw new HttpError(401, '请先登录');
  const payload = await verifySessionToken(env.SESSION_SECRET, token);
  if (!payload) throw new HttpError(401, '登录已过期，请重新登录');
  const user = await env.DB.prepare(
    'SELECT id, username, email, status, role, github_star, slots_extra FROM users WHERE id = ?1',
  )
    .bind(payload.uid)
    .first<SessionUser & { status?: string }>();
  if (!user) throw new HttpError(401, '账号不存在');
  if (user.status === 'disabled') throw new HttpError(403, '账号已被禁用，请联系管理员');
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    role: user.role ?? 'user',
    github_star: user.github_star ?? 0,
    slots_extra: user.slots_extra ?? 0,
  };
}

async function requireAdmin(request: Request, env: Env): Promise<SessionUser> {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') throw new HttpError(403, '需要管理员权限');
  return user;
}

async function withCf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    throw new HttpError(502, `${label}失败：${msg}`);
  }
}

function maxSlotsFor(u: SessionUser): number {
  return Math.min(MAX_SLOTS, BASE_SLOTS + (u.github_star ? 1 : 0) + (u.slots_extra ?? 0));
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

async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (rateLimited('register:' + clientIp(request), 20, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return json({ error: '用户名需为 3-32 位小写字母、数字或下划线' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return json({ error: '密码至少 8 位' }, 400);

  const dupName = await env.DB.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
  if (dupName) return json({ error: '该用户名已被占用，请换一个' }, 409);
  const dupEmail = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (dupEmail) return json({ error: '该邮箱已注册，请直接登录或找回密码' }, 409);

  const row = await env.DB.prepare('SELECT sent_count, last_sent_at FROM reg_codes WHERE email = ?1')
    .bind(email).first<{ sent_count: number; last_sent_at: number | null }>();
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
    ).bind(codeHash, hash, salt, username, expiresAt, now, email).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reg_codes (email, code_hash, pass_hash, pass_salt, username, expires_at, sent_count, last_sent_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)`,
    ).bind(email, codeHash, hash, salt, username, expiresAt, now).run();
  }

  const sent = await sendCodeEmail(env, email, code);
  if (!sent.delivered) {
    await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
    return json({ error: '验证码发送失败：邮件服务尚未接入，请联系管理员' }, 502);
  }
  return json({ ok: true, message: '验证码已发送到你的邮箱', email });
}

async function handleRegisterVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const code = String(body?.code ?? '').trim();
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '验证码格式不正确' }, 400);
  const row = await env.DB.prepare(
    'SELECT code_hash, pass_hash, pass_salt, username, expires_at, attempts FROM reg_codes WHERE email = ?1',
  ).bind(email).first<{ code_hash: string; pass_hash: string; pass_salt: string; username: string | null; expires_at: number; attempts: number }>();
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
    `INSERT INTO users (username, email, pass_hash, pass_salt, email_verified, status, role, created_via)
     VALUES (?1, ?2, ?3, ?4, 1, 'active', 'user', 'register')`,
  ).bind(username, email, row.pass_hash, row.pass_salt).run();
  await env.DB.prepare('DELETE FROM reg_codes WHERE email = ?1').bind(email).run();
  const user = await env.DB.prepare('SELECT id, username FROM users WHERE email = ?1').bind(email).first<{ id: number; username: string }>();
  if (!user) return json({ error: '注册失败，请重试' }, 500);
  const token = await createSessionToken(env.SESSION_SECRET, { uid: user.id, exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 });
  return json({ ok: true, username: user.username }, 200, { 'Set-Cookie': setSessionCookie(token, SESSION_MAX_AGE_SECONDS) });
}

async function handleForgotPassword(request: Request, env: Env): Promise<Response> {
  if (rateLimited('forgot:' + clientIp(request), 10, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?1 AND email_verified = 1').bind(email).first();
  if (!user) return json({ ok: true, message: '若该邮箱已注册，验证码将发送至你的邮箱' });
  const row = await env.DB.prepare('SELECT sent_count, last_sent_at FROM reset_codes WHERE email = ?1')
    .bind(email).first<{ sent_count: number; last_sent_at: number | null }>();
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
    ).bind(codeHash, expiresAt, now, email).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reset_codes (email, code_hash, expires_at, sent_count, last_sent_at) VALUES (?1, ?2, ?3, 1, ?4)`,
    ).bind(email, codeHash, expiresAt, now).run();
  }
  const sent = await sendResetCodeEmail(env, email, code);
  if (!sent.delivered) {
    await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
    return json({ error: '验证码发送失败，请联系管理员' }, 502);
  }
  return json({ ok: true, message: '验证码已发送到你的邮箱', email });
}

async function handleResetPassword(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const code = String(body?.code ?? '').trim();
  const newPassword = String(body?.password ?? '');
  if (!EMAIL_RE.test(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: '验证码格式不正确' }, 400);
  if (newPassword.length < 8) return json({ error: '密码至少 8 位' }, 400);
  const row = await env.DB.prepare('SELECT code_hash, expires_at, attempts FROM reset_codes WHERE email = ?1')
    .bind(email).first<{ code_hash: string; expires_at: number; attempts: number }>();
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
  await env.DB.prepare('UPDATE users SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3').bind(hash, salt, user.id).run();
  await env.DB.prepare('DELETE FROM reset_codes WHERE email = ?1').bind(email).run();
  return json({ ok: true, message: '密码已重置，请重新登录' });
}

/** 修改密码（登录后，需旧密码） */
async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson(request);
  const oldPassword = String(body?.oldPassword ?? '');
  const newPassword = String(body?.newPassword ?? '');
  if (!oldPassword || !newPassword) return json({ error: '请输入旧密码和新密码' }, 400);
  if (newPassword.length < 8) return json({ error: '新密码至少 8 位' }, 400);
  const u = await env.DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?1').bind(user.id).first<{ pass_hash: string; pass_salt: string }>();
  if (!u || !(await verifyPassword(oldPassword, u.pass_salt, u.pass_hash))) {
    return json({ error: '旧密码错误' }, 401);
  }
  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET pass_hash = ?1, pass_salt = ?2 WHERE id = ?3').bind(hash, salt, user.id).run();
  return json({ ok: true, message: '密码已修改' });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM subdomains WHERE user_id = ?1').bind(user.id).first<{ n: number }>();
  return json({
    username: user.username,
    email: user.email,
    role: user.role,
    rootDomain: env.ROOT_DOMAIN,
    maxSlots: maxSlotsFor(user),
    usedSlots: used?.n ?? 0,
    githubStar: user.github_star ?? 0,
    slotsExtra: user.slots_extra ?? 0,
  });
}

// ---------- 公开统计 ----------
async function handleStats(env: Env): Promise<Response> {
  const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subdomains').first<{ n: number }>();
  const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?1').bind('user').first<{ n: number }>();
  const days = Math.max(1, Math.floor((Date.now() - LAUNCH_MS) / 86_400_000));
  return json({ subdomains: subs?.n ?? 0, users: users?.n ?? 0, days });
}

// ---------- 可用性检测（公开） ----------
async function isNameAvailable(env: Env, name: string): Promise<{ available: boolean; reason?: string }> {
  const reserved = await env.DB.prepare('SELECT name FROM reserved_subdomains WHERE name = ?1').bind(name).first();
  if (reserved) return { available: false, reason: '该前缀为平台保留，不可申请' };
  const local = await env.DB.prepare('SELECT id FROM subdomains WHERE name = ?1 LIMIT 1').bind(name).first();
  if (local) return { available: false, reason: '该前缀已被其他用户占用' };
  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  const remote = await withCf('DNS 查询', () => cf.listByName(`${name}.${env.ROOT_DOMAIN}`));
  if (remote.length > 0) return { available: false, reason: '该前缀在 DNS 中已被占用' };
  return { available: true };
}

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
  const res = await isNameAvailable(env, sub);
  return json({ available: res.available, reason: res.reason, fqdn });
}

// ---------- 卡槽管理 ----------
interface SlotRow {
  id: number;
  name: string;
  expires_at: number | null;
  renewed_at: number | null;
  ddns_token: string | null;
  created_at: string;
}

async function handleListSlots(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const slots = await env.DB.prepare(
    'SELECT id, name, expires_at, renewed_at, ddns_token, created_at FROM subdomains WHERE user_id = ?1 ORDER BY created_at DESC',
  ).bind(user.id).all<SlotRow>();
  const now = Date.now();
  // 反代目标单独查一次：万一迁移还没执行，也不会让整个列表接口挂掉
  const proxyTargets = new Map<number, string>();
  try {
    const rows = await env.DB.prepare(
      'SELECT id, proxy_target FROM subdomains WHERE user_id = ?1 AND proxy_target IS NOT NULL',
    )
      .bind(user.id)
      .all<{ id: number; proxy_target: string }>();
    for (const r of rows.results ?? []) proxyTargets.set(r.id, r.proxy_target);
  } catch {
    /* proxy_target 列不存在（迁移未执行）：忽略即可 */
  }
  const out = [];
  for (const s of slots.results ?? []) {
    const rec = await env.DB.prepare('SELECT type, value FROM records WHERE subdomain_id = ?1').bind(s.id).first<{ type: string; value: string }>();
    const exp = s.expires_at ?? 0;
    const remaining = exp - now;
    out.push({
      id: s.id,
      name: s.name,
      record: rec ? { type: rec.type, value: rec.value } : null,
      created_at: s.created_at,
      expires_at: exp,
      days_remaining: Math.max(0, Math.floor(remaining / 86_400_000)),
      renewable: remaining > 0 && remaining <= RENEW_WINDOW_MS,
      expired: remaining <= 0,
      ddns_token: s.ddns_token ?? '',
      proxy_target: proxyTargets.get(s.id) ?? null,
    });
  }
  return json({ slots: out, rootDomain: env.ROOT_DOMAIN, maxSlots: maxSlotsFor(user) });
}

/** 申请卡槽（仅占用前缀，不设置记录） */
async function handleCreateSlot(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  if (rateLimited('slot:' + user.id, 30, 3600_000)) {
    return json({ error: '操作过于频繁，请稍后再试' }, 429);
  }
  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().toLowerCase();
  const err = validateSubdomain(name);
  if (err) return json({ error: err }, 400);

  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM subdomains WHERE user_id = ?1').bind(user.id).first<{ n: number }>();
  const max = maxSlotsFor(user);
  if ((used?.n ?? 0) >= max) {
    return json({ error: `已达卡槽上限 ${max} 个（第 2 个需 GitHub 星标，第 3-5 个联系管理员开启）` }, 403);
  }

  const avail = await isNameAvailable(env, name);
  if (!avail.available) return json({ error: avail.reason ?? '该前缀不可用' }, 409);

  const expiresAt = Date.now() + RECORD_LIFETIME_MS;
  await env.DB.prepare(
    'INSERT INTO subdomains (user_id, name, expires_at, ddns_token) VALUES (?1, ?2, ?3, ?4)',
  ).bind(user.id, name, expiresAt, genToken()).run();
  return json({ ok: true, created: true, name, expires_at: expiresAt });
}

/** 使用卡槽：设置 / 更新 DNS 记录 */
async function handleSetRecord(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/record$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id, name FROM subdomains WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first<{ id: number; name: string }>();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);

  const proxied = await readProxyTarget(env, id);
  if (proxied) {
    return json({ error: `该子域名已开启反代（${proxied}），与 DNS 记录互斥。请先关闭反代再设置记录。` }, 409);
  }

  const body = await readJson(request);
  const type = String(body?.type ?? '').toUpperCase();
  let value = String(body?.value ?? '').trim();
  if (type === 'CNAME') value = value.replace(/\.+$/, '').toLowerCase(); // 规范化：去尾点 + 小写
  if (type !== 'A' && type !== 'AAAA' && type !== 'CNAME') return json({ error: '记录类型仅支持 A / AAAA / CNAME' }, 400);
  const verr = validateValue(type, value, env.ROOT_DOMAIN);
  if (verr) return json({ error: verr }, 400);
  const fqdn = `${slot.name}.${env.ROOT_DOMAIN}`;

  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  const existing = await env.DB.prepare('SELECT id, cf_record_id FROM records WHERE subdomain_id = ?1').bind(id).first<{ id: number; cf_record_id: string | null }>();
  if (existing) {
    const rec = await withCf('DNS 更新', () => cf.update(existing.cf_record_id ?? '', { type, name: fqdn, content: value }));
    await env.DB.prepare('UPDATE records SET type = ?1, value = ?2, cf_record_id = ?3, updated_at = ?4 WHERE id = ?5')
      .bind(type, value, rec.id, new Date().toISOString(), existing.id).run();
    return json({ ok: true, updated: true, name: slot.name, fqdn, type, value });
  }

  const remote = await withCf('DNS 查询', () => cf.listByName(fqdn));
  if (remote.length > 0) return json({ error: '该域名在 DNS 中已被占用' }, 409);
  const rec = await withCf('DNS 写入', () => cf.create({ type, name: fqdn, content: value }));
  await env.DB.prepare('INSERT INTO records (subdomain_id, type, value, cf_record_id) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, type, value, rec.id).run();
  return json({ ok: true, created: true, name: slot.name, fqdn, type, value });
}

/** 删除卡槽的记录 */
async function handleDeleteRecord(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/record$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id FROM subdomains WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);
  const rec = await env.DB.prepare('SELECT id, cf_record_id FROM records WHERE subdomain_id = ?1').bind(id).first<{ id: number; cf_record_id: string | null }>();
  if (rec) {
    const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
    try { await cf.remove(rec.cf_record_id ?? ''); } catch (e) { console.warn('DNS 删除失败（继续）:', e); }
    await env.DB.prepare('DELETE FROM records WHERE id = ?1').bind(rec.id).run();
  }
  return json({ ok: true });
}

/** 释放卡槽（本人或管理员） */
async function handleDeleteSlot(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id, user_id FROM subdomains WHERE id = ?1').bind(id).first<{ id: number; user_id: number }>();
  if (!slot) return json({ error: '卡槽不存在' }, 404);
  if (slot.user_id !== user.id && user.role !== 'admin') return json({ error: '无权操作' }, 403);
  const rec = await env.DB.prepare('SELECT id, cf_record_id FROM records WHERE subdomain_id = ?1').bind(id).first<{ id: number; cf_record_id: string | null }>();
  if (rec) {
    const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
    try { await cf.remove(rec.cf_record_id ?? ''); } catch (e) { console.warn('DNS 删除失败（继续）:', e); }
  }
  await env.DB.prepare('DELETE FROM subdomains WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}

async function handleRenewSlot(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/renew$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id, name, expires_at FROM subdomains WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id).first<{ id: number; name: string; expires_at: number | null }>();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);
  const now = Date.now();
  const remaining = (slot.expires_at ?? 0) - now;
  if (remaining <= 0) return json({ error: '该域名已过期，无法续期' }, 400);
  if (remaining > RENEW_WINDOW_MS) return json({ error: '尚未到可续期时间（剩余超过 6 个月）' }, 400);
  const newExp = now + RECORD_LIFETIME_MS;
  await env.DB.prepare('UPDATE subdomains SET expires_at = ?1, renewed_at = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(newExp, now, new Date().toISOString(), id).run();
  return json({ ok: true, name: slot.name, expires_at: newExp });
}

async function handleRegenDDNSToken(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/ddns-token$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id FROM subdomains WHERE id = ?1 AND user_id = ?2').bind(id, user.id).first();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);
  const token = genToken();
  await env.DB.prepare('UPDATE subdomains SET ddns_token = ?1 WHERE id = ?2').bind(token, id).run();
  return json({ ok: true, ddns_token: token });
}

// ---------- DDNS ----------
async function handleDDNS(request: Request, env: Env): Promise<Response> {
  if (rateLimited('ddns:' + clientIp(request), 60, 60_000)) return ddnsText('911');
  const url = new URL(request.url);
  const token = (url.searchParams.get('token') ?? '').trim();
  const ipParam = (url.searchParams.get('ip') ?? '').trim();
  if (!token || token.length < 16) return ddnsText('badauth');
  const slot = await env.DB.prepare('SELECT id, name, expires_at FROM subdomains WHERE ddns_token = ?1')
    .bind(token).first<{ id: number; name: string; expires_at: number | null }>();
  if (!slot) return ddnsText('nohost');
  if (slot.expires_at !== null && slot.expires_at < Date.now()) return ddnsText('nohost');
  const rec = await env.DB.prepare('SELECT id, type, value, cf_record_id FROM records WHERE subdomain_id = ?1')
    .bind(slot.id).first<{ id: number; type: string; value: string; cf_record_id: string | null }>();
  if (!rec) return ddnsText('notfqdn');
  if (rec.type === 'CNAME') return ddnsText('notfqdn');
  const newIp = ipParam || request.headers.get('CF-Connecting-IP') || '';
  const err = validateValue(rec.type, newIp, env.ROOT_DOMAIN);
  if (err) return ddnsText('911');
  if (newIp === rec.value) return ddnsText(`nochg ${newIp}`);
  const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
  try {
    await cf.update(rec.cf_record_id ?? '', { type: rec.type, name: `${slot.name}.${env.ROOT_DOMAIN}`, content: newIp });
  } catch (e) {
    console.error('DDNS 更新失败:', e);
    return ddnsText('911');
  }
  await env.DB.prepare('UPDATE records SET value = ?1, updated_at = ?2 WHERE id = ?3').bind(newIp, new Date().toISOString(), rec.id).run();
  return ddnsText(`good ${newIp}`);
}

// ---------- 管理员 ----------
/** 引导建号：Bearer ADMIN_PASSWORD 创建账号（默认管理员，可指定角色） */
async function handleAdminCreateUser(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!safeEqual(auth, 'Bearer ' + env.ADMIN_PASSWORD)) {
    return json({ error: '无权操作' }, 401);
  }
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  const role = String(body?.role ?? 'admin').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) return json({ error: '用户名需为 3-32 位小写字母、数字或下划线' }, 400);
  if (password.length < 8) return json({ error: '密码至少 8 位' }, 400);
  if (role !== 'admin' && role !== 'user') return json({ error: '角色不合法' }, 400);
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare('INSERT INTO users (username, pass_hash, pass_salt, role, created_via) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(username, hash, salt, role, 'admin').run();
  } catch {
    return json({ error: '用户名已存在' }, 409);
  }
  return json({ ok: true, username, role });
}

async function handleAdminUsers(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare(
    `SELECT id, username, email, role, status, github_star, slots_extra, email_verified, created_at,
            (SELECT COUNT(*) FROM subdomains s WHERE s.user_id = users.id) AS slot_count
     FROM users ORDER BY id`,
  ).all();
  return json({ users: rows.results ?? [] });
}

async function handleAdminSetRole(request: Request, env: Env, path: string): Promise<Response> {
  await requireAdmin(request, env);
  const m = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const body = await readJson(request);
  const role = String(body?.role ?? '').trim().toLowerCase();
  if (role !== 'admin' && role !== 'user') return json({ error: '角色不合法' }, 400);
  await env.DB.prepare('UPDATE users SET role = ?1 WHERE id = ?2').bind(role, id).run();
  return json({ ok: true });
}

async function handleAdminSetSlots(request: Request, env: Env, path: string): Promise<Response> {
  await requireAdmin(request, env);
  const m = path.match(/^\/api\/admin\/users\/(\d+)\/slots$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const body = await readJson(request);
  const extra = Number(body?.extra ?? 0);
  if (!Number.isInteger(extra) || extra < 0 || extra > (MAX_SLOTS - BASE_SLOTS)) {
    return json({ error: `额外卡槽需在 0-${MAX_SLOTS - BASE_SLOTS} 之间` }, 400);
  }
  const star = body?.githubStar ? 1 : 0;
  await env.DB.prepare('UPDATE users SET slots_extra = ?1, github_star = ?2 WHERE id = ?3').bind(extra, star, id).run();
  return json({ ok: true });
}

async function handleAdminSlots(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const base = (proxyCol: string) =>
    `SELECT s.id, s.name, s.expires_at, s.created_at, u.username, u.email,
            ${proxyCol} AS proxy_target,
            (SELECT r.type FROM records r WHERE r.subdomain_id = s.id) AS type,
            (SELECT r.value FROM records r WHERE r.subdomain_id = s.id) AS value
     FROM subdomains s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC`;
  try {
    const rows = await env.DB.prepare(base('s.proxy_target')).all();
    return json({ slots: rows.results ?? [] });
  } catch {
    // proxy_target 列不存在（迁移未执行）：退回旧查询，管理端照常可用
    const rows = await env.DB.prepare(base('NULL')).all();
    return json({ slots: rows.results ?? [] });
  }
}

async function handleAdminReserved(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare('SELECT name, created_at FROM reserved_subdomains ORDER BY name').all();
  return json({ reserved: rows.results ?? [] });
}

/**
 * 反代用量与防护配置（管理员）。
 *
 * 用量数字来自 Worker 内存按批汇总写入 proxy_usage，是**近似值** ——
 * isolate 被回收时未落盘的计数会丢，实际用量通常略高于这里看到的。
 */
async function handleAdminUsage(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  let rows: unknown[] = [];
  try {
    const r = await env.DB.prepare(
      'SELECT day, requests, proxied, limited, alerted, updated_at FROM proxy_usage ORDER BY day DESC LIMIT 14',
    ).all();
    rows = r.results ?? [];
  } catch {
    /* proxy_usage 表不存在（迁移未执行）：返回空列表而不是 500 */
  }
  const today = utcDay();
  return json({
    usage: rows,
    today,
    // 本 isolate 尚未落盘的内存计数，仅供参考
    pending: usage.day === today ? usage.requests : 0,
    threshold: numVar(env.USAGE_ALERT_THRESHOLD, 80000),
    cache: { ttl_seconds: numVar(env.PROXY_CACHE_TTL, 30), entries: slotCache.size },
    rate_limit_per_min: numVar(env.RATE_LIMIT_PER_MIN, 1200),
    // 诊断用：原生限流 binding 是否真的挂上了。为 false 时说明只靠内存兜底（按 isolate，偏宽松）
    rate_limiter_bound: Boolean(env.RATE_LIMITER),
  });
}

async function handleAdminAddReserved(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const name = String(body?.name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) || name.length < 2) {
    return json({ error: '保留域名格式不合法' }, 400);
  }
  try {
    await env.DB.prepare('INSERT INTO reserved_subdomains (name) VALUES (?1)').bind(name).run();
  } catch {
    return json({ error: '该保留域名已存在' }, 409);
  }
  return json({ ok: true, name });
}

async function handleAdminDelReserved(request: Request, env: Env, path: string): Promise<Response> {
  await requireAdmin(request, env);
  const name = decodeURIComponent(path.split('/').pop() ?? '');
  await env.DB.prepare('DELETE FROM reserved_subdomains WHERE name = ?1').bind(name).run();
  return json({ ok: true });
}

// ---------- 到期清理 + 提醒 ----------
async function runExpiryReminders(env: Env): Promise<number> {
  const day = 86_400_000;
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT s.id, s.name, s.expires_at, s.reminder_level, u.email
     FROM subdomains s JOIN users u ON u.id = s.user_id
     WHERE u.email IS NOT NULL AND u.email_verified = 1 AND s.expires_at IS NOT NULL`,
  ).all<{ id: number; name: string; expires_at: number; reminder_level: number; email: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    const remain = r.expires_at - now;
    if (remain <= 0) continue;
    const days = Math.floor(remain / day);
    const level = r.reminder_level ?? 0;
    let next = level;
    try {
      if (days <= 7 && level < 2) { await sendExpiryReminder(env, r.email, r.name, Math.max(days, 1)); next = 2; }
      else if (days <= 30 && level < 1) { await sendExpiryReminder(env, r.email, r.name, days); next = 1; }
      else continue;
      await env.DB.prepare('UPDATE subdomains SET reminder_level = ?1 WHERE id = ?2').bind(next, r.id).run();
      n += 1;
    } catch (e) { console.error(`提醒发送失败 ${r.name}:`, e); }
  }
  return n;
}

async function runExpiryCleanup(env: Env): Promise<number> {
  const now = Date.now();
  const expired = await env.DB.prepare('SELECT id, name FROM subdomains WHERE expires_at < ?1').bind(now).all<{ id: number; name: string }>();
  let n = 0;
  for (const s of expired.results ?? []) {
    try {
      const rec = await env.DB.prepare('SELECT cf_record_id FROM records WHERE subdomain_id = ?1').bind(s.id).first<{ cf_record_id: string | null }>();
      if (rec?.cf_record_id) {
        const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
        try { await cf.remove(rec.cf_record_id); } catch (e) { console.warn(`释放 ${s.name}: DNS 删除失败`, e); }
      }
      await env.DB.prepare('DELETE FROM subdomains WHERE id = ?1').bind(s.id).run();
      n += 1;
      console.log(`[cleanup] 已释放到期域名: ${s.name}.${env.ROOT_DOMAIN}`);
    } catch (e) { console.error('清理失败:', e); }
  }
  return n;
}

// ---------- 定时任务 ----------
async function scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  try {
    const reminded = await runExpiryReminders(env);
    console.log(`[cron] 到期提醒 ${reminded} 封`);
    const released = await runExpiryCleanup(env);
    console.log(`[cron] 释放 ${released} 个`);
  } catch (e) {
    console.error('[cron] 执行失败:', e);
  }
}

// ---------- 子域名反代（把 xxx.fblog.cyou 转发到用户自己的 Workers / Pages）----------
//
// 背景：Cloudflare 早已不允许把子域名添加为独立 zone（API 报 1116），
// 所以「用户把 xxx.fblog.cyou 绑到自己 Cloudflare 账号」这条路已经走不通了。
// 替代方案：平台用通配路由 *.fblog.cyou/* 收下全部子域名请求，再按 Host 反代到
// 用户自己在 Workers/Pages 上的部署地址。用户依旧「用自己的 Worker」，只是多了一跳。

/** 平台自身占用的子域名前缀：这些 Host 走平台界面，绝不参与反代 */
const PLATFORM_LABELS = new Set(['dns', 'www']);

/**
 * 平台入口前缀 = 内置的 dns/www + env.PLATFORM_HOSTS。
 *
 * 为什么需要这个开关：官方文档明确「Routes can fetch() Custom Domains and take
 * precedence if configured on the same hostname」—— 通配路由 `*.fblog.cyou/*`
 * 会抢走本 zone 内**其它 Worker 的自定义域名**（只有更精确的路由才能赢过通配）。
 * 把这类前缀登记到 PLATFORM_HOSTS，它们就会走平台界面而不是被当成用户卡槽。
 */
function platformLabels(env: Env): Set<string> {
  const extra = (env.PLATFORM_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return extra.length ? new Set([...PLATFORM_LABELS, ...extra]) : PLATFORM_LABELS;
}

/** 解析 env.PASSTHROUGH_HOSTS */
function passthroughLabels(env: Env): Set<string> {
  const list = (env.PASSTHROUGH_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(list);
}

/** 转发时应剥掉的逐跳首部（RFC 7230 §6.1） */
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// ---------- 反代用的缓存 / 限流 / 用量统计 ----------

function numVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

interface CachedSlot {
  id: number;
  proxy_target: string | null;
  expires_at: number | null;
  at: number;
}

/**
 * name → 卡槽 的内存缓存。
 * 只缓存「查到了」的结果 —— 没查到不缓存，这样新申请的子域名立刻可用、不会先看到 404。
 * 代价是用户改配置后最长 PROXY_CACHE_TTL 秒才生效。
 */
const slotCache = new Map<string, CachedSlot>();
const CACHE_MAX_ENTRIES = 5000;

/** 原生 RATE_LIMITER 不可用时的内存限流兜底（按 isolate，偏宽松，仅为防滥用） */
const memLimit = new Map<string, { n: number; reset: number }>();

/** 用量计数：每个 isolate 各记各的，按批汇总写入 D1，因此是近似值 */
interface UsageCounter {
  day: string;
  requests: number;
  proxied: number;
  limited: number;
  lastFlush: number;
}
let usage: UsageCounter = freshUsage();

function freshUsage(): UsageCounter {
  return { day: utcDay(), requests: 0, proxied: 0, limited: 0, lastFlush: Date.now() };
}

type SlotLookup = { kind: 'found'; slot: CachedSlot } | { kind: 'missing' } | { kind: 'error' };

/** 查询卡槽，带内存缓存 */
async function lookupSlot(env: Env, label: string): Promise<SlotLookup> {
  const ttlMs = numVar(env.PROXY_CACHE_TTL, 30) * 1000;
  const now = Date.now();

  if (ttlMs > 0) {
    const hit = slotCache.get(label);
    if (hit && now - hit.at < ttlMs) return { kind: 'found', slot: hit };
  }

  try {
    const row = await env.DB.prepare('SELECT id, proxy_target, expires_at FROM subdomains WHERE name = ?1 LIMIT 1')
      .bind(label)
      .first<{ id: number; proxy_target: string | null; expires_at: number | null }>();
    if (!row) return { kind: 'missing' };
    const slot: CachedSlot = { id: row.id, proxy_target: row.proxy_target, expires_at: row.expires_at, at: now };
    if (ttlMs > 0) {
      if (slotCache.size >= CACHE_MAX_ENTRIES) slotCache.clear();
      slotCache.set(label, slot);
    }
    return { kind: 'found', slot };
  } catch (e) {
    console.error('反代查询失败:', e);
    return { kind: 'error' };
  }
}

/** 返回 true 表示放行 */
async function allowRequest(env: Env, label: string): Promise<boolean> {
  const limiter = env.RATE_LIMITER;
  if (limiter) {
    try {
      const { success } = await limiter.limit({ key: `proxy:${label}` });
      return success;
    } catch (e) {
      // 原生限流组件出问题时退回内存兜底 —— 直接放行等于限流被静默关掉
      console.error('原生限流调用失败，退回内存限流:', e);
    }
  }
  return memoryAllow(env, label);
}

function memoryAllow(env: Env, label: string): boolean {
  const limit = numVar(env.RATE_LIMIT_PER_MIN, 1200);
  if (limit <= 0) return true;
  const now = Date.now();
  const entry = memLimit.get(label);
  if (!entry || now >= entry.reset) {
    if (memLimit.size >= CACHE_MAX_ENTRIES) memLimit.clear();
    memLimit.set(label, { n: 1, reset: now + 60_000 });
    return true;
  }
  entry.n += 1;
  return entry.n <= limit;
}

const USAGE_FLUSH_EVERY = 200; // 每 200 次请求落盘一次，把 D1 写放大压到 0.5% 以内
const USAGE_FLUSH_MS = 60_000;

/** 记一次用量；到期就异步汇总写入 D1（不阻塞响应） */
function bumpUsage(env: Env, ctx: ExecutionContext, hit: { proxied?: boolean; limited?: boolean }): void {
  const today = utcDay();
  if (usage.day !== today) usage = freshUsage();
  usage.requests += 1;
  if (hit.proxied) usage.proxied += 1;
  if (hit.limited) usage.limited += 1;

  if (usage.requests < USAGE_FLUSH_EVERY && Date.now() - usage.lastFlush < USAGE_FLUSH_MS) return;
  const snapshot: UsageCounter = { ...usage };
  usage = freshUsage();
  ctx.waitUntil(flushUsage(env, snapshot));
}

async function flushUsage(env: Env, snap: UsageCounter): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO proxy_usage (day, requests, proxied, limited, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(day) DO UPDATE SET
         requests   = requests + excluded.requests,
         proxied    = proxied  + excluded.proxied,
         limited    = limited  + excluded.limited,
         updated_at = excluded.updated_at`,
    )
      .bind(snap.day, snap.requests, snap.proxied, snap.limited, new Date().toISOString())
      .run();
  } catch (e) {
    console.error('用量落盘失败（迁移未执行？）:', e);
    return;
  }
  await maybeAlertUsage(env, snap.day);
}

/**
 * 当日用量超过阈值就给管理员发告警邮件。
 * 用「条件更新」原子抢占 alerted 标记，保证同一天即使多个 isolate 同时判断，也只发一封。
 */
async function maybeAlertUsage(env: Env, day: string): Promise<void> {
  const threshold = numVar(env.USAGE_ALERT_THRESHOLD, 80000);
  if (threshold <= 0) return;
  try {
    const row = await env.DB.prepare('SELECT requests, proxied, limited, alerted FROM proxy_usage WHERE day = ?1')
      .bind(day)
      .first<{ requests: number; proxied: number; limited: number; alerted: number }>();
    if (!row || row.alerted || row.requests < threshold) return;

    const claim = await env.DB.prepare('UPDATE proxy_usage SET alerted = 1 WHERE day = ?1 AND alerted = 0')
      .bind(day)
      .run();
    if (!claim.meta || claim.meta.changes <= 0) return; // 别的 isolate 已经发过了

    const admins = await env.DB.prepare(
      "SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND status = 'active'",
    ).all<{ email: string }>();
    for (const a of admins.results ?? []) {
      await sendUsageAlert(env, a.email, {
        day,
        requests: row.requests,
        proxied: row.proxied,
        limited: row.limited,
        threshold,
      });
    }
  } catch (e) {
    console.error('用量告警处理失败:', e);
  }
}

/** 限流命中时返回的页面 */
function rateLimitedPage(env: Env, host: string): Response {
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>请求过于频繁 · ${escapeHtml(host)}</title></head>` +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f1e6;color:#1c1712\">" +
    '<div style="max-width:520px;padding:32px;text-align:center">' +
    '<h1 style="font-size:20px;margin:0 0 12px">请求过于频繁</h1>' +
    '<p style="margin:0 0 10px;color:#5b5147;line-height:1.8">该域名短时间内收到太多请求，已被平台限流。</p>' +
    '<p style="margin:0 0 22px;color:#5b5147;line-height:1.8">请稍后重试。</p>' +
    `<a href="https://dns.${escapeHtml(env.ROOT_DOMAIN)}/" style="display:inline-block;padding:10px 18px;border-radius:8px;` +
    'background:#1c1712;color:#f6f1e6;text-decoration:none;font-weight:600">前往 fblog.cyou 免费二级域名平台</a>' +
    '</div></body></html>';
  return new Response(html, {
    status: 429,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '60',
      'Cache-Control': 'no-store',
    },
  });
}

/** 无目标 / 已过期 / 未登记时给访客看的落地页 */
function landingPage(env: Env, host: string, kind: 'unregistered' | 'expired' | 'idle'): Response {
  const title = kind === 'expired' ? '子域名已过期' : kind === 'idle' ? '尚未指向任何内容' : '子域名不存在';
  const detail =
    kind === 'expired'
      ? '这个子域名已过期并被平台回收，可以重新申请。'
      : kind === 'idle'
        ? '这个子域名已被占用，但所有者还没有把它指向自己的网站或 Worker。'
        : '这个子域名还没有被任何人申请。';
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    `<title>${title} · ${escapeHtml(host)}</title></head>` +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f6f1e6;color:#1c1712\">" +
    '<div style="max-width:520px;padding:32px;text-align:center">' +
    `<h1 style="font-size:20px;margin:0 0 12px">${title}</h1>` +
    `<p style="margin:0 0 10px;color:#5b5147;line-height:1.8">${detail}</p>` +
    `<p style="margin:0 0 22px;color:#5b5147;line-height:1.8"><code style="background:#eae2d2;padding:2px 6px;border-radius:4px">${escapeHtml(host)}</code></p>` +
    `<a href="https://dns.${escapeHtml(env.ROOT_DOMAIN)}/" style="display:inline-block;padding:10px 18px;border-radius:8px;` +
    'background:#1c1712;color:#f6f1e6;text-decoration:none;font-weight:600">前往 fblog.cyou 免费二级域名平台</a>' +
    '</div></body></html>';
  return new Response(html, {
    status: kind === 'unregistered' ? 404 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * 把响应里的 Location 从「目标主机」改回「用户看到的域名」，
 * 否则浏览器会被甩到 xxx.workers.dev 上，地址栏就暴露且跨域了。
 */
function rewriteLocation(location: string, outUrl: URL, targetHost: string): string {
  try {
    const abs = new URL(location, outUrl);
    return abs.host === targetHost ? abs.pathname + abs.search + abs.hash : location;
  } catch {
    return location;
  }
}

/** 把请求原样转发到用户登记的 Workers/Pages 地址 */
async function proxyTo(target: string, request: Request, host: string): Promise<Response> {
  const base = new URL(target);
  const inUrl = new URL(request.url);
  const outUrl = new URL(inUrl.pathname + inUrl.search, base);

  const headers = new Headers(request.headers);
  for (const h of HOP_BY_HOP_HEADERS) headers.delete(h);
  // Host 由 fetch 依据 outUrl 自动生成，手动设置会被运行时忽略甚至报错
  headers.delete('host');
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  headers.set('X-Forwarded-Host', host);
  headers.set('X-Forwarded-Proto', 'https');
  if (ip) {
    headers.set('X-Real-IP', ip);
    headers.set('X-Forwarded-For', ip);
  }
  // 让用户的后端知道「访问者实际访问的是哪个域名」
  headers.set('X-Original-Host', host);

  const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = request.body;
  }

  let resp: Response;
  try {
    resp = await fetch(outUrl.toString(), init);
  } catch (e) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>上游无响应</title>' +
        '<body style="font-family:system-ui;background:#f6f1e6;color:#1c1712;padding:24px">' +
        '<h2>无法连接到目标服务</h2><p style="color:#5b5147;line-height:1.8">' +
        '目标 Workers/Pages 没有响应，可能已被删除、改名或暂停。</p><pre style="white-space:pre-wrap;color:#8a7f72">' +
        escapeHtml((e as Error)?.message ?? String(e)) +
        '</pre></body>',
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
    );
  }

  // 非重定向：原样透传，绝不重建 Response —— 避免破坏 content-length / 内容编码。
  const loc = resp.headers.get('Location');
  if (!loc) return resp;

  // 重定向：把 Location 从目标主机改回用户看到的域名，否则浏览器会被甩到
  // xxx.workers.dev 上（地址栏暴露且跨域）。
  const outHeaders = new Headers(resp.headers);
  outHeaders.set('Location', rewriteLocation(loc, outUrl, base.host));
  // body 重新包装后长度不再可信，交给运行时按 chunked 处理。
  outHeaders.delete('content-length');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: outHeaders });
}

/** 读取卡槽的反代目标；迁移未执行时返回 null，保证平台在迁移前也能正常跑 */
async function readProxyTarget(env: Env, subdomainId: number): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT proxy_target FROM subdomains WHERE id = ?1')
      .bind(subdomainId)
      .first<{ proxy_target: string | null }>();
    return row?.proxy_target ?? null;
  } catch {
    return null;
  }
}

/** 检测泛解析记录是否已配置；查不出来时返回 false，避免误报吓到用户 */
async function wildcardRecordMissing(env: Env): Promise<boolean> {
  try {
    const cf = new CfDns(env.CF_API_TOKEN, env.CF_ZONE_ID);
    const recs = await cf.listByName(`*.${env.ROOT_DOMAIN}`);
    return recs.length === 0;
  } catch {
    return false;
  }
}

/** 按 Host 分发子域名请求 */
async function handleProxyDispatch(
  request: Request,
  env: Env,
  label: string,
  host: string,
  ctx: ExecutionContext,
): Promise<Response> {
  // 先限流：这是唯一能被外部恶意触发、进而拖垮所有用户站点（共用平台免费额度）的风险
  if (!(await allowRequest(env, label))) {
    bumpUsage(env, ctx, { limited: true });
    return rateLimitedPage(env, host);
  }

  const lookup = await lookupSlot(env, label);
  if (lookup.kind === 'error') {
    bumpUsage(env, ctx, {});
    return landingPage(env, host, 'idle');
  }
  if (lookup.kind === 'missing') {
    bumpUsage(env, ctx, {});
    return landingPage(env, host, 'unregistered');
  }

  const slot = lookup.slot;
  if ((slot.expires_at ?? 0) <= Date.now()) {
    bumpUsage(env, ctx, {});
    return landingPage(env, host, 'expired');
  }
  if (!slot.proxy_target) {
    bumpUsage(env, ctx, {});
    return landingPage(env, host, 'idle');
  }

  bumpUsage(env, ctx, { proxied: true });
  return await proxyTo(slot.proxy_target, request, host);
}

/** 开启/更新反代：POST /api/slots/:id/proxy */
async function handleSetProxy(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/proxy$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id, name FROM subdomains WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id)
    .first<{ id: number; name: string }>();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);

  const body = await readJson(request);
  const raw = String(body?.target ?? '').trim();
  const verr = validateProxyTarget(raw, env.ROOT_DOMAIN);
  if (verr) return json({ error: verr }, 400);
  const target = normalizeProxyTarget(raw);

  // DNS 记录与反代互斥：有记录时请求根本不会走到 Worker（解析直接指向别处），
  // 反代形同虚设，用户会以为坏了 —— 所以这里直接拦住并说清楚。
  const rec = await env.DB.prepare('SELECT type, value FROM records WHERE subdomain_id = ?1')
    .bind(id)
    .first<{ type: string; value: string }>();
  if (rec) {
    return json(
      { error: `该子域名已设置 ${rec.type} 记录（${rec.value}），与反代互斥。请先删除记录，再开启反代。` },
      409,
    );
  }

  await env.DB.prepare('UPDATE subdomains SET proxy_target = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(target, new Date().toISOString(), id)
    .run();

  const missing = await wildcardRecordMissing(env);
  return json({
    ok: true,
    name: slot.name,
    fqdn: `${slot.name}.${env.ROOT_DOMAIN}`,
    target,
    warning: missing
      ? `尚未检测到 *.${env.ROOT_DOMAIN} 的泛解析记录，子域名无法解析到平台。请联系管理员添加 AAAA *.${env.ROOT_DOMAIN} → 100::（已代理 / 橙云）。`
      : undefined,
  });
}

/** 关闭反代：DELETE /api/slots/:id/proxy */
async function handleDeleteProxy(request: Request, env: Env, path: string): Promise<Response> {
  const user = await requireUser(request, env);
  const m = path.match(/^\/api\/slots\/(\d+)\/proxy$/);
  if (!m) return json({ error: 'not found' }, 404);
  const id = Number(m[1]);
  const slot = await env.DB.prepare('SELECT id FROM subdomains WHERE id = ?1 AND user_id = ?2')
    .bind(id, user.id)
    .first();
  if (!slot) return json({ error: '卡槽不存在或无权操作' }, 404);
  await env.DB.prepare('UPDATE subdomains SET proxy_target = NULL, updated_at = ?1 WHERE id = ?2')
    .bind(new Date().toISOString(), id)
    .run();
  return json({ ok: true });
}

// ---------- 入口 ----------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 反代分发：*.fblog.cyou 的访问交给用户登记的 Workers/Pages；
      // 平台自身入口（dns./www./根域）不参与，继续走下面的界面与 API。
      const rootDomain = (env.ROOT_DOMAIN ?? '').toLowerCase();
      const host = url.hostname.toLowerCase();
      if (rootDomain && host !== rootDomain && host.endsWith('.' + rootDomain)) {
        const label = host.slice(0, host.length - rootDomain.length - 1);
        // 透传名单：把原始请求 fetch 出去，交还给该主机名「自定义域名」背后的那个
        // Worker（子请求不会被路由拦截，所以不会再次落回本通配路由）。
        if (passthroughLabels(env).has(label)) {
          try {
            return await fetch(request);
          } catch (e) {
            console.error(`透传 ${host} 失败:`, e);
            return landingPage(env, host, 'idle');
          }
        }
        if (!platformLabels(env).has(label)) {
          return await handleProxyDispatch(request, env, label, host, ctx);
        }
      }

      // 静态资源（主页、独立页、robots、sitemap 等）：直接透传原始请求，
      // 由 assets 运行时处理干净 URL（/ → index.html、/how → how.html 等）
      if (request.method === 'GET' && !path.startsWith('/api/')) {
        return await env.ASSETS.fetch(request);
      }

      if (!path.startsWith('/api/')) {
        return json({ error: 'not found' }, 404);
      }

      ensureEnv(env);

      switch (path) {
        case '/api/login': return await handleLogin(request, env);
        case '/api/logout': return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
        case '/api/me': return await handleMe(request, env);
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
        case '/api/password/change':
          if (request.method === 'POST') return await handleChangePassword(request, env);
          break;
        case '/api/stats':
          if (request.method === 'GET') return await handleStats(env);
          break;
        case '/api/check':
          if (request.method === 'GET') return await handleCheckRecord(request, env);
          break;
        case '/api/slots':
          if (request.method === 'GET') return await handleListSlots(request, env);
          if (request.method === 'POST') return await handleCreateSlot(request, env);
          break;
        case '/api/ddns':
          if (request.method === 'GET') return await handleDDNS(request, env);
          break;
        case '/api/admin/users':
          if (request.method === 'GET') return await handleAdminUsers(request, env);
          if (request.method === 'POST') return await handleAdminCreateUser(request, env);
          break;
        case '/api/admin/slots':
          if (request.method === 'GET') return await handleAdminSlots(request, env);
          break;
        case '/api/admin/reserved':
          if (request.method === 'GET') return await handleAdminReserved(request, env);
          if (request.method === 'POST') return await handleAdminAddReserved(request, env);
          break;
        case '/api/admin/usage':
          if (request.method === 'GET') return await handleAdminUsage(request, env);
          break;
      }

      let mm: RegExpMatchArray | null;
      if (request.method === 'POST' && (mm = path.match(/^\/api\/slots\/(\d+)\/record$/))) {
        return await handleSetRecord(request, env, path);
      }
      if (request.method === 'POST' && (mm = path.match(/^\/api\/slots\/(\d+)\/proxy$/))) {
        return await handleSetProxy(request, env, path);
      }
      if (request.method === 'DELETE' && (mm = path.match(/^\/api\/slots\/(\d+)\/proxy$/))) {
        return await handleDeleteProxy(request, env, path);
      }
      if (request.method === 'DELETE' && (mm = path.match(/^\/api\/slots\/(\d+)\/record$/))) {
        return await handleDeleteRecord(request, env, path);
      }
      if (request.method === 'POST' && (mm = path.match(/^\/api\/slots\/(\d+)\/renew$/))) {
        return await handleRenewSlot(request, env, path);
      }
      if (request.method === 'POST' && (mm = path.match(/^\/api\/slots\/(\d+)\/ddns-token$/))) {
        return await handleRegenDDNSToken(request, env, path);
      }
      if (request.method === 'DELETE' && (mm = path.match(/^\/api\/slots\/(\d+)$/))) {
        return await handleDeleteSlot(request, env, path);
      }
      if (request.method === 'POST' && (mm = path.match(/^\/api\/admin\/users\/(\d+)\/role$/))) {
        return await handleAdminSetRole(request, env, path);
      }
      if (request.method === 'POST' && (mm = path.match(/^\/api\/admin\/users\/(\d+)\/slots$/))) {
        return await handleAdminSetSlots(request, env, path);
      }
      if (request.method === 'DELETE' && path.startsWith('/api/admin/reserved/')) {
        return await handleAdminDelReserved(request, env, path);
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
          '<body style="font-family:system-ui;background:#f6f1e6;color:#1c1712;padding:24px">' +
          '<h2>页面加载失败（HTTP 500）</h2><pre style="white-space:pre-wrap">' +
          escapeHtml(err?.message ?? String(e)) + '\n' + escapeHtml(err?.stack ?? '') +
          '</pre></body>',
        { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await scheduled(event, env, ctx);
  },
};