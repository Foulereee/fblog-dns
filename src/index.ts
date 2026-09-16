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

  const body = await readJson(request);
  const type = String(body?.type ?? '').toUpperCase();
  const value = String(body?.value ?? '').trim();
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
  const rows = await env.DB.prepare(
    `SELECT s.id, s.name, s.expires_at, s.created_at, u.username, u.email,
            (SELECT r.type FROM records r WHERE r.subdomain_id = s.id) AS type,
            (SELECT r.value FROM records r WHERE r.subdomain_id = s.id) AS value
     FROM subdomains s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC`,
  ).all();
  return json({ slots: rows.results ?? [] });
}

async function handleAdminReserved(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  const rows = await env.DB.prepare('SELECT name, created_at FROM reserved_subdomains ORDER BY name').all();
  return json({ reserved: rows.results ?? [] });
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

// ---------- 入口 ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

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
      }

      let mm: RegExpMatchArray | null;
      if (request.method === 'POST' && (mm = path.match(/^\/api\/slots\/(\d+)\/record$/))) {
        return await handleSetRecord(request, env, path);
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