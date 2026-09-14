/**
 * fblog.cyou 免费二级域名分发平台 - Worker 入口
 *
 * 一个 Worker 同时提供：
 *   GET  /                    前端管理页面
 *   POST /api/login            登录（账号由管理员发放）
 *   POST /api/logout           退出
 *   GET  /api/me               当前用户信息
 *   GET  /api/records          我的记录列表
 *   POST /api/records          创建 / 更新记录（A/AAAA/CNAME）
 *   DELETE /api/records/:id    删除我的记录
 *   POST /api/admin/users      管理员创建用户（Bearer ADMIN_PASSWORD）
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
} from './auth';
import { validateSubdomain, validateValue } from './validate';
import { CfDns } from './cloudflare';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ROOT_DOMAIN: string;
}

const MAX_RECORDS_PER_USER = 10;
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

/**
 * 把 Cloudflare API 调用包装成可读的错误（502 + 具体原因），
 * 同时确保 rejection 在 await 内被 try/catch 捕获。
 */
async function withCf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    throw new HttpError(502, `${label}失败：${msg}`);
  }
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
}

async function requireUser(request: Request, env: Env): Promise<SessionUser> {
  const token = readCookie(request.headers.get('Cookie'));
  if (!token) throw new HttpError(401, '请先登录');
  const payload = await verifySessionToken(env.SESSION_SECRET, token);
  if (!payload) throw new HttpError(401, '登录已过期，请重新登录');
  const user = await env.DB.prepare('SELECT id, username FROM users WHERE id = ?1')
    .bind(payload.uid)
    .first<SessionUser>();
  if (!user) throw new HttpError(401, '账号不存在');
  return user;
}

// ---------- 路由处理 ----------
async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (rateLimited('login:' + clientIp(request), 10, 60_000)) {
    return json({ error: '尝试过于频繁，请一分钟后再试' }, 429);
  }
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!username || !password) return json({ error: '请输入用户名和密码' }, 400);

  const user = await env.DB.prepare(
    'SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?1',
  )
    .bind(username)
    .first<{ id: number; username: string; pass_hash: string; pass_salt: string }>();
  if (!user || !(await verifyPassword(password, user.pass_salt, user.pass_hash))) {
    return json({ error: '用户名或密码错误' }, 401);
  }

  const token = await createSessionToken(env.SESSION_SECRET, {
    uid: user.id,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return json({ ok: true, username: user.username }, 200, {
    'Set-Cookie': setSessionCookie(token, SESSION_MAX_AGE_SECONDS),
  });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  return json({ username: user.username, rootDomain: env.ROOT_DOMAIN });
}

interface RecordRow {
  id: number;
  subdomain: string;
  type: string;
  value: string;
  created_at: string;
  updated_at: string;
}

async function handleListRecords(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const res = await env.DB.prepare(
    `SELECT id, subdomain, type, value, created_at, updated_at
     FROM records WHERE user_id = ?1 ORDER BY created_at DESC`,
  )
    .bind(user.id)
    .all<RecordRow>();
  return json({
    records: res.results,
    rootDomain: env.ROOT_DOMAIN,
    maxRecords: MAX_RECORDS_PER_USER,
  });
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

  // 已有同前缀同类型记录 → 更新（仅限本人）
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

  // 全新记录：配额检查 + Cloudflare 查重（防止与平台外手工创建的记录冲突）
  const quota = await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?1')
    .bind(user.id)
    .first<{ n: number }>();
  if ((quota?.n ?? 0) >= MAX_RECORDS_PER_USER) {
    return json({ error: `已达到每个账号 ${MAX_RECORDS_PER_USER} 条记录的配额上限` }, 403);
  }
  const remote = await withCf('DNS 查询', () => cf.listByName(fqdn));
  if (remote.length > 0) {
    return json({ error: '该子域名在 DNS 中已被占用（可能为平台外手工创建）' }, 409);
  }

  const rec = await withCf('DNS 写入', () => cf.create({ type, name: fqdn, content: value }));
  await env.DB.prepare(
    'INSERT INTO records (user_id, subdomain, type, value, cf_record_id) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(user.id, sub, type, value, rec.id)
    .run();
  return json({ ok: true, created: true, fqdn, type, value });
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
    await env.DB.prepare('INSERT INTO users (username, pass_hash, pass_salt) VALUES (?1, ?2, ?3)')
      .bind(username, hash, salt)
      .run();
  } catch {
    return json({ error: '用户名已存在' }, 409);
  }
  return json({ ok: true, username });
}

// ---------- 入口 ----------
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 整个处理都在 try 内：任何异常都转为可见的错误响应，避免生产环境 1101 盲区
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // 前端页面（由 public/ 静态资源提供；必须 return await，否则 rejection 逃出 catch）
      if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
        return await env.ASSETS.fetch(request);
      }

      if (!path.startsWith('/api/')) {
        return json({ error: 'not found' }, 404);
      }

      ensureEnv(env);

      switch (path) {
        case '/api/login':
          // 注意：必须 return await，否则 handler 的 rejection 不会被外层 catch 捕获
          return await handleLogin(request, env);
        case '/api/logout':
          return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
        case '/api/me':
          return await handleMe(request, env);
        case '/api/records':
          if (request.method === 'GET') return await handleListRecords(request, env);
          if (request.method === 'POST') return await handleCreateRecord(request, env);
          break;
        case '/api/admin/users':
          if (request.method === 'POST') return await handleAdminCreateUser(request, env);
          break;
      }

      if (request.method === 'DELETE' && path.startsWith('/api/records/')) {
        return await handleDeleteRecord(request, env, path);
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      // 用鸭子类型判断 HttpError（instanceof 在部分打包/本地运行环境下不可靠）
      const err = e as { status?: unknown; message?: string; stack?: string };
      const isApi = request.url.includes('/api/');
      if (isApi) {
        if (typeof err?.status === 'number' && err.status >= 400 && err.status < 600) {
          return json({ error: err.message ?? '请求失败' }, err.status);
        }
        console.error('未处理异常:', e);
        return json({ error: '服务器内部错误' }, 500);
      }
      // 页面请求出错：直接显示错误，便于排障（正常时应永远走不到这里）
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
};
