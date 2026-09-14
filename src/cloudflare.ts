/**
 * Cloudflare DNS API 封装（V4 REST API）
 * 文档: https://developers.cloudflare.com/api/resources/dns/
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CfResponse<T> {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
}

export class CfDns {
  constructor(
    private readonly token: string,
    private readonly zoneId: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${CF_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let data: CfResponse<T> | null = null;
    try {
      data = (await res.json()) as CfResponse<T>;
    } catch {
      data = null;
    }

    if (!res.ok || !data || data.success === false) {
      const msg = data?.errors?.[0]?.message ?? `Cloudflare API 返回 HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data.result as T;
  }

  /** 按完整域名精确查找记录（name 参数是精确匹配） */
  async listByName(name: string): Promise<Array<{ id: string; type: string; name: string; content: string }>> {
    return this.request('GET', `/zones/${this.zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
  }

  async create(rec: { type: string; name: string; content: string }): Promise<{ id: string }> {
    return this.request('POST', `/zones/${this.zoneId}/dns_records`, {
      type: rec.type,
      name: rec.name,
      content: rec.content,
      ttl: 1, // 自动
      proxied: false, // 仅 DNS（灰云），用户自管服务器与证书
      comment: 'fblog-dns platform',
    });
  }

  async update(
    recordId: string,
    rec: { type: string; name: string; content: string },
  ): Promise<{ id: string }> {
    return this.request('PUT', `/zones/${this.zoneId}/dns_records/${recordId}`, {
      type: rec.type,
      name: rec.name,
      content: rec.content,
      ttl: 1,
      proxied: false,
      comment: 'fblog-dns platform',
    });
  }

  async remove(recordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${this.zoneId}/dns_records/${recordId}`);
  }
}
