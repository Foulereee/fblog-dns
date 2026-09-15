/**
 * 认证模块：PBKDF2 密码哈希 + HMAC 签名会话 Cookie
 * 全部使用 WebCrypto，零第三方依赖
 */

const enc = new TextEncoder();

/** 常数时间字符串比较，防止时序攻击 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** PBKDF2-SHA256 哈希密码，返回 { hash, salt } */
export async function hashPassword(
  password: string,
  salt?: string,
): Promise<{ hash: string; salt: string }> {
  const s =
    salt ??
    Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(s), iterations: 100_000, hash: 'SHA-256' },
    key,
    256,
  );
  const hash = Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { hash, salt: s };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  return safeEqual(hash, expectedHash);
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/** 生成签名会话 token：base64url(payload).hmac */
export async function createSessionToken(
  secret: string,
  payload: { uid: number; exp: number },
): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(secret, body);
  return `${body}.${sig}`;
}

/** 校验会话 token，返回 payload 或 null */
export async function verifySessionToken(
  secret: string,
  token: string,
): Promise<{ uid: number; exp: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmacHex(secret, body);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as { uid?: unknown; exp?: unknown };
    if (typeof payload.uid !== 'number' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return { uid: payload.uid, exp: payload.exp };
  } catch {
    return null;
  }
}

export const COOKIE_NAME = 'fblog_session';

export function setSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  return null;
}

// ---------- 邮箱注册相关 ----------

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 生成 6 位数字验证码 */
export function genEmailCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/** 验证码哈希（SHA-256 hex），存库不存明文 */
export async function hashEmailCode(code: string, email: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`${email}:${code}`));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 从邮箱生成默认用户名：取 @ 前缀，转为小写字母/数字/下划线，
 * 最短 3 位；冲突检查由调用方保证唯一（追加序号）。
 */
export function usernameFromEmail(email: string): string {
  let base = email.split('@')[0].toLowerCase();
  base = base.replace(/[^a-z0-9_]/g, '_');
  if (base.length < 3) base = base + '_dns';
  if (base.length > 32) base = base.slice(0, 32);
  return base;
}
