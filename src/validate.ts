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
