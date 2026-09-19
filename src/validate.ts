/**
 * 子域名与记录值校验
 */

/** 保留字：平台自身、常见系统记录，禁止用户占用 */
export const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'mail', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2',
  'ns3', 'ns4', 'dns', 'dns1', 'dns2', 'admin', 'root', 'ftp', 'cpanel', 'webmail',
  'blog', 'status', 'test', 'dev', 'staging', 'autodiscover', 'autoconfig',
  '_dmarc', '_acme-challenge', 'verify', 'support', 'help', 'info', 'about',
  'shop', 'store', 'login', 'signin', 'oauth', 'cdn', 'static', 'assets', 'img',
  'media', 'download', 'files', 'web', 'app', 'console', 'dashboard', 'panel',
]);

/** 校验子域名前缀，返回错误信息或 null */
export function validateSubdomain(sub: string): string | null {
  if (!sub || sub.length < 2 || sub.length > 63) {
    return '子域名长度需为 2-63 个字符';
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) {
    return '子域名只能包含小写字母、数字和连字符，且必须以字母或数字开头和结尾';
  }
  if (RESERVED_SUBDOMAINS.has(sub)) {
    return '该前缀已被保留，请换一个';
  }
  return null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// 覆盖常见 IPv6 写法的完整正则（含 :: 压缩、IPv4-mapped）
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/;

/** 校验记录值，返回错误信息或 null */
export function validateValue(type: string, value: string, rootDomain: string): string | null {
  const v = value.trim();
  if (!v) return '记录值不能为空';

  if (type === 'A') {
    const m = IPV4_RE.exec(v);
    if (!m) return 'A 记录需要合法的 IPv4 地址，例如 1.2.3.4';
    if (m.slice(1).some((p) => Number(p) > 255)) {
      return 'A 记录需要合法的 IPv4 地址，每段不能超过 255';
    }
    return null;
  }

  if (type === 'AAAA') {
    if (!IPV6_RE.test(v)) return 'AAAA 记录需要合法的 IPv6 地址，例如 2001:db8::1';
    return null;
  }

  if (type === 'CNAME') {
    // 去掉末尾点（FQDN 写法）并小写。Cloudflare 跨账号自定义域名（CNAME setup）
    // 给出的目标形如 `xxx.fblog.cyou.cdn.cloudflare.net.`，常带尾点，需兼容。
    const c = v.replace(/\.+$/, '').toLowerCase();
    if (!c) return 'CNAME 目标不能为空';
    if (/^https?:\/\//i.test(c)) return 'CNAME 目标不需要 http(s):// 前缀';
    if (/^[\d.]+$/.test(c) || c.includes(':')) return 'CNAME 目标需要是一个域名，不能是 IP 地址';
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(c) || c.length > 253) {
      return 'CNAME 目标域名不合法';
    }
    const rd = rootDomain.toLowerCase();
    if (c === rd || c.endsWith('.' + rd)) {
      return '不允许 CNAME 指向本域名自身，防止解析循环';
    }
    return null;
  }

  return '仅支持 A / AAAA / CNAME 三种记录类型';
}

/**
 * 允许被反代的来源后缀。
 *
 * 这是刻意的安全边界 —— 不限制的话平台就成了任人使用的公开反向代理，
 * 很容易被拿去做滥用流量、绕过对方封禁等事情。
 *
 * 只收录「各大云厂商的 serverless / 边缘函数」专用域名，且必须由该厂商完全控制。
 * **刻意不收录**对象存储（OSS/COS）与通用 API 网关域名：前者等于放行所有 bucket，
 * 容易被拿来托管恶意文件；后者任何人都能挂，边界太宽。
 */
export const PROXY_ALLOWED_SUFFIXES = ['.workers.dev', '.pages.dev', '.fcapp.run', '.tencentscf.com'];

/** 上面各后缀的裸域名：用户只填它本身时给一句更有用的提示 */
const PROXY_BARE_DOMAINS = ['workers.dev', 'pages.dev', 'fcapp.run', 'tencentscf.com'];

/**
 * 校验反代目标地址，返回错误信息或 null。
 * @param input 用户填写的地址，例如 `https://my-worker.my-name.workers.dev`
 * @param rootDomain 平台根域名，用于阻止把自己反代给自己
 */
export function validateProxyTarget(input: string, rootDomain: string): string | null {
  const raw = input.trim();
  if (!raw) return '反代目标不能为空';

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '反代目标需要是完整网址，例如 https://my-worker.my-name.workers.dev';
  }

  if (u.protocol !== 'https:') return '反代目标必须使用 https://（这些平台都自带 HTTPS）';
  if (u.username || u.password) return '反代目标不能包含用户名或密码';

  const host = u.hostname.toLowerCase();
  if (PROXY_BARE_DOMAINS.includes(host)) {
    return `请填写具体的项目地址（例如 my-app.xxx${host === 'fcapp.run' ? '.cn-hangzhou' : ''}.${host}），而不是 ${host} 本身`;
  }
  if (!PROXY_ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return (
      '反代目标只支持这些平台的地址：Cloudflare Workers（*.workers.dev）、Cloudflare Pages（*.pages.dev）、' +
      '阿里云函数计算（*.fcapp.run）、腾讯云云函数（*.tencentscf.com）'
    );
  }
  if (host.includes('_')) return '反代目标的域名部分不能包含下划线';

  const rd = rootDomain.toLowerCase();
  if (host === rd || host.endsWith('.' + rd)) {
    return '反代目标不能指向本域名自身，防止回环';
  }

  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    return '反代目标只填到域名即可，不要带路径、查询参数或锚点';
  }
  return null;
}

/** 把用户输入规整成规范的 origin（`https://host`），仅在 validateProxyTarget 通过后调用 */
export function normalizeProxyTarget(input: string): string {
  return new URL(input.trim()).origin;
}

// ---------- 附加 TXT 记录 ----------

/**
 * TXT 记录名的允许形态：**必须以 `_` 开头**。
 *
 * 这是刻意的限制，不是疏漏。TXT 只用于各类「域名归属校验」场景
 * （阿里云 ESA 的 `_esaauth`、腾讯 EdgeOne 的归属校验、ACME 的
 * `_acme-challenge`、SPF/DMARC 等），这些名字按惯例全部以下划线开头。
 *
 * 强制下划线的好处：
 *   1. 下划线前缀不是合法主机名，因此不可能与卡槽自身的 A/AAAA/CNAME
 *      记录冲突，也不可能与其他用户的子域名撞名；
 *   2. 无法用 TXT 在某个真实主机名上伪造内容（例如冒充别人的站点）；
 *   3. 校验逻辑简单可靠，不需要额外查重。
 *
 * 若将来确实需要非下划线开头的 TXT，应先想清冲突与滥用问题再放开。
 */
const TXT_NAME_RE = /^_[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/;

/** TXT 值长度上限：DNS 单条 TXT 字符串的通行上限 */
export const TXT_VALUE_MAX = 255;

/** 单个卡槽最多允许多少条附加 TXT（防止被拿来当免费存储刷） */
export const TXT_PER_SLOT_MAX = 5;

/** 校验附加 TXT 的记录名（不含卡槽名与根域名），返回错误信息或 null */
export function validateTxtName(input: unknown): string | null {
  if (typeof input !== 'string') return '记录名必须是文本';
  const n = input.trim().toLowerCase();
  if (!n) return '记录名不能为空';
  if (!n.startsWith('_')) {
    return '记录名必须以 _ 开头（例如 _esaauth，用于域名归属校验）';
  }
  if (n.length > 63) return '记录名最长 63 个字符';
  if (!TXT_NAME_RE.test(n)) {
    return '记录名只能包含小写字母、数字、下划线和连字符，且不能以连字符结尾';
  }
  return null;
}

/** 规整 TXT 记录名：去空白 + 小写 */
export function normalizeTxtName(input: unknown): string {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

/**
 * 校验 TXT 记录值，返回错误信息或 null。
 *
 * 允许空格与常见可见字符（校验串里确实可能出现），但拒绝控制字符和换行 ——
 * 换行会被 D1 控制台粘贴、日志与 CSV 导出等环节放大成注入风险，
 * 且没有哪种归属校验需要它。
 */
export function validateTxtValue(input: unknown): string | null {
  if (typeof input !== 'string') return '记录值必须是文本';
  const v = input.trim();
  if (!v) return '记录值不能为空';
  if (/[\u0000-\u001f\u007f]/.test(v)) return '记录值不能包含控制字符或换行';
  if (v.length > TXT_VALUE_MAX) return `记录值最长 ${TXT_VALUE_MAX} 个字符`;
  return null;
}

/** 规整 TXT 记录值：去首尾空白 */
export function normalizeTxtValue(input: unknown): string {
  return typeof input === 'string' ? input.trim() : '';
}

// ---------- 卡槽备注 ----------

/** 卡槽备注的长度上限（按字符数，不是字节数） */
export const SLOT_NOTE_MAX = 20;

/**
 * 校验卡槽备注。返回错误信息或 null。
 * 允许为空（表示清除备注）。
 */
export function validateSlotNote(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') return '备注必须是文本';
  if (/[\u0000-\u001f\u007f]/.test(input)) return '备注不能包含控制字符或换行';
  if ([...input.trim()].length > SLOT_NOTE_MAX) return `备注最多 ${SLOT_NOTE_MAX} 个字符`;
  return null;
}

/** 规整备注：去掉首尾空白，空串归一成 null（表示清除） */
export function normalizeSlotNote(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  return s ? s : null;
}
