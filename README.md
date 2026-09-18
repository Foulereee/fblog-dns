# fblog.cyou 免费二级域名分发平台

> 📘 **想直接上线？请按 [DEPLOY.md](./DEPLOY.md) 部署文档操作**（NS 迁移、Token 创建、
> D1 初始化、上线、发号、安全清单，逐阶段带验证命令）。

在 Cloudflare 上运行的一个轻量「二级域名分发」平台：管理员发放账号，用户登录后自助申请
`xxx.fblog.cyou` 子域名并设置 **A / AAAA / CNAME** 记录，平台通过 Cloudflare API 自动写入 DNS，即时生效。

技术栈：**Cloudflare Workers**（API + 前端页面一体） + **Cloudflare D1**（SQLite 边缘数据库） + Cloudflare DNS API。零运行时依赖，全部免费额度内运行。

## 架构

```
用户浏览器 ──▶ dns.fblog.cyou（Worker）
                  │
                  ├── D1 数据库（用户 / 记录）
                  └── Cloudflare DNS API（创建/更新/删除 fblog.cyou 的 DNS 记录）
                         │
                         ▼
                xxx.fblog.cyou 即刻可解析
```

- 记录全部为「仅 DNS（灰云）」模式，用户自行负责服务器与 HTTPS 证书；
- 相同「前缀 + 类型」再次提交 = 更新；CNAME 与 A/AAAA 在同一前缀下互斥；
- 每个账号默认最多 10 条记录（改 `src/index.ts` 里 `MAX_RECORDS_PER_USER`）；
- 密码 PBKDF2-SHA256 哈希存储，会话为 HMAC 签名 Cookie，均用 WebCrypto 实现。

## 一、把 fblog.cyou 的 NS 迁到 Cloudflare（一次性）

1. 注册/登录 [Cloudflare](https://dash.cloudflare.com/) → **Add a site** → 输入 `fblog.cyou` → 选 **Free** 计划；
2. Cloudflare 会引导你复制现有 DNS 记录（从 Spaceship 的 NS 自动扫描），确认后继续；
3. Cloudflare 会给你两个 nameserver（形如 `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com`）；
4. 去 [Spaceship](https://www.spaceship.com/) 的域名管理页，把 fblog.cyou 的 Nameservers 改成这两个（Spaceship 也支持用它的 API：`PUT /v1/domains/fblog.cyou/nameservers`）；
5. 等待生效：`dig NS fblog.cyou` 返回 Cloudflare 的 NS 即成功（通常几分钟到几小时）。

> 迁移后所有 DNS 记录都归 Cloudflare 管，原平台（Spaceship）的解析不再生效。

## 二、创建 Cloudflare API Token（最小权限）

1. 控制台右上角头像 → **My Profile** → **API Tokens** → **Create Token**；
2. 选模板 **Edit zone DNS**：
   - Permissions：Zone → DNS → **Edit**（可再勾上 Read）；
   - Zone Resources：**Specific zone → fblog.cyou**（只授权这一个域名！）；
3. 创建后**立刻复制保存** Token（只显示一次）；
4. 在 fblog.cyou 的 **Overview** 页面右侧复制 **Zone ID**。

## 三、本地部署

要求：Node.js 18+、已安装 npm。

```bash
cd fblog-dns
npm install

# 1. 创建 D1 数据库，会输出 database_id
npm run db:create
# 把输出的 database_id 填进 wrangler.jsonc 的 d1_databases[0].database_id

# 2. 初始化数据库表（线上）
npm run db:init

# 3. 写入敏感配置（每个命令会交互式输入）
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
npx wrangler secret put ADMIN_PASSWORD   # 管理员创建用户时的口令
npx wrangler secret put SESSION_SECRET    # 生成: openssl rand -hex 32

# 4. 本地调试（可选）：先复制 .dev.vars.example 为 .dev.vars 并填好值
npm run dev
# 浏览器打开 http://localhost:8787

# 5. 上线
npm run deploy
# 会输出 https://fblog-dns.<你的子域>.workers.dev
```

## 四、创建第一个用户（管理员发放账号）

```bash
curl -X POST https://fblog-dns.<你的子域>.workers.dev/api/admin/users \
  -H "Authorization: Bearer 你的ADMIN_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"一个至少8位的密码"}'
```

把用户名和密码发给用户即可。

## 五、（推荐）绑定自己的域名访问管理面板

让用户访问 `https://dns.fblog.cyou` 而不是 `.workers.dev`：

1. 控制台 fblog.cyou → **Workers Routes**（或 Worker 详情 → Settings → Domains → **Add Custom Domain**）→ 添加 `dns.fblog.cyou` 指向 `fblog-dns` worker；
2. 等 Cloudflare 自动创建 CNAME 并签发证书，访问 `https://dns.fblog.cyou` 即面板。
3. 用上面的 curl 把地址换成 `https://dns.fblog.cyou/api/admin/users`。

## 用户自助部署到 Workers/Pages（可选）

> ⚠️ **先纠正一个常见误解**：Cloudflare **不允许把子域名添加为独立 zone**。以下都是实测结果：
> - 「添加站点」填 `xxx.fblog.cyou` → 被 `1116 Please ensure you are providing the root domain...` 拒绝，
>   **父域在不在 Cloudflare 上、在谁的账号里，结果都一样**；
> - 官方给子域名的正规通路是 **CNAME setup（建 zone 时 `type: partial`）**，
>   但它要 **Business 及以上套餐** —— 免费账号会返回 `1104 Partial zone signup not allowed`；
> - **Cloudflare for SaaS / Custom Hostnames** 需要**销售对接 / Enterprise 配额**，免费账号返回
>   `1404 No quota has been allocated for this zone or for this account`。
>
> 结论：**给用户「完整 zone」这条路走不通**，平台改为提供下面两条替代路线。

### 路线 A（推荐，免费账号也能用）：平台反代

用户把 `xxx.fblog.cyou` 指向自己在 Cloudflare 上部署的 Workers / Pages ——
**代码、部署、更新都在用户自己账号里**，平台只做一层透明转发。

1. 用户在自己的 Cloudflare 账号部署 Workers（得到 `my-worker.my-name.workers.dev`）
   或 Pages（得到 `my-project.pages.dev`）；
2. 用户到本平台「我的子域名」→ 该卡槽点 **开启反代** → 填入该地址 → 保存；
3. 访问 `https://xxx.fblog.cyou` 即转发到用户的部署。

实现方式：平台用 **Workers 通配路由 `*.fblog.cyou/*`** 收下全部子域名请求，按 Host 反查 D1，
再 `fetch()` 转发到用户登记的目标。转发时会剥掉逐跳首部、补上
`X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Real-IP` / `X-Original-Host`，
并把重定向响应里的 `Location` 从目标主机改回用户看到的域名。

**🔴 上线前的一次性前置条件（漏了会发现子域名根本不解析）：**

```
AAAA  *.fblog.cyou   100::    代理状态：已代理（橙云）
```

没有这条泛解析，子域名解析不到 Cloudflare 边缘，通配路由永远不会触发。
已有「仅 DNS（灰云）」记录的子域名**优先级更高**，照旧直连用户自己的服务器 —— 两套机制互不干扰。

**🔴 升级已有部署：先跑迁移，再发代码**

`subdomains` 表新增了 `proxy_target` 列，顺序不能反：

```bash
npx wrangler d1 execute fblog-dns-db --remote --file=./migration-proxy.sql
```

代码里对这个查询做了兜底（列不存在也不会让平台挂掉），但反代功能要等迁移跑完才生效。

用量统计另需一张表（同样有兜底：未执行时不会报错，只是没有统计数据）：

```bash
npx wrangler d1 execute fblog-dns-db --remote --file=./migration-usage.sql
```

> 代价：反代请求会消耗**平台自己**的 Workers 额度（免费 10 万请求/天），且平台能看到这些流量。
> 额度是**全平台共享**的 —— 一个被刷的站点能拖垮所有人，所以务必确认下文的三个防护已生效。
> 另外反代只放行 `*.workers.dev` 与 `*.pages.dev` 目标，这是刻意的安全边界 ——
> 不限制的话平台就成了任人使用的公开反向代理。

### 路线 B（仅 Business+ 套餐可用）：CNAME setup

用户在自己账号把 `xxx.fblog.cyou` 添加为 **CNAME setup** 的 zone，拿到
`xxx.fblog.cyou.cdn.cloudflare.net` 目标，再填进本平台的 **CNAME** 记录。
**免费账号走不通（`1104`）**，所以平台把 CNAME 校验放宽到接受 `*.cdn.cloudflare.net`
（含尾点写法）只是为了服务这部分付费用户。

> **两条路互斥**：同一个卡槽要么填 DNS 记录（含路线 B 的 CNAME），要么开反代。
> 同时设置时请求会被 DNS 直接解析走、根本到不了 Worker，所以平台会直接拦住并提示原因。
> 面向用户的图文说明见 `/how`。

## 六、上线后的安全清单（务必做）

- [ ] 在 Cloudflare **Security → WAF → Rate limiting rules** 加两条免费规则：保护 `/api/login`（如 10 次/分钟/IP）和 `/api/records`（如 30 次/小时/IP）；
- [ ] **确认反代限流生效**：对某个反代子域名持续请求，超过 1200 次/分钟（每个 Cloudflare 机房）后应开始返回 **429**；
- [ ] **确认用量统计可用**：面板「管理后台 → 反向代理用量」能看到今天的请求数；同时确认管理员账号绑定了能收信的邮箱，否则额度告警发不出去；
- [ ] **盯住 Workers 每日请求数**（面板 Workers → Metrics）。跑到 8 成就该处理 —— 跑满会让**所有反代站点一起 522**，不是只影响一家；
- [ ] 确认 API Token 只授权了 `fblog.cyou` 一个 zone；
- [ ] `ADMIN_PASSWORD` 与 `SESSION_SECRET` 使用长随机值，勿复用；
- [ ] 定期检查记录：`npx wrangler d1 execute fblog-dns-db --remote --command "SELECT * FROM records"`，删除僵尸记录；
- [ ] 扩展保留字表：`src/validate.ts` 的 `RESERVED_SUBDOMAINS`；
- [ ] 如面向公众开放，补齐正式的 TOS/AUP 页面与滥用举报入口（滥用者会把整个 fblog.cyou 拖下水，甚至触发注册局对整域名的处置）。

## 免费额度参考（2025 年起）

| 项目 | 免费额度 |
| --- | --- |
| Workers | 10 万请求/天（午夜 UTC 重置） |
| D1 | 500 万行读/天、10 万行写/天、共 5 GB 存储 |
| Cloudflare DNS | 无限记录、全球 anycast |

如果没有开启反代，你的量级（几十到几百个子域名）完全在免费额度内。

### ⚠️ 反代开启后，额度变成全平台共享

反代把**所有**用户子域名的流量都引到平台自己的 Worker 上，吃的是**平台账号**的额度，不是用户自己的：

- 用户站点的**每一次访问 = 平台 1 次 Worker 请求**
- 10 万/天 ÷ 假设 50 个反代站点 ≈ **每家每天只有 2,000 次**
- 额度跑满时 Cloudflare 返回错误 **1027**；若该路由是 **fail open**，请求会绕过 Worker 回源到占位地址 `100::`，结果是**所有反代站点一起返回 522**
- 子请求（转发到用户 Worker 那一步）**不计费**；带宽也完全免费

**内建防护**

| 措施 | 配置项 | 说明 |
| --- | --- | --- |
| 限流 | `wrangler.jsonc` 的 `ratelimits`（默认 1200 次/60 秒）与 `RATE_LIMIT_PER_MIN` | 保护额度不被单个站点刷爆。原生 binding 不可用时自动退回内存计数兜底。⚠️ 官方额度粒度是**单个 Cloudflare 机房**，不是全局 —— 全球访问的站点实际允许量约为 limit × 命中机房数。它是滥用防护，不是精确计费控制 |
| 查询缓存 | `PROXY_CACHE_TTL`（默认 30 秒，设 `0` 关闭） | 省掉每请求一次 D1 往返、降低转发延迟。只缓存「查到了」的结果，新申请的子域名立刻可用；代价是用户改配置后最长 30 秒才生效 |
| 用量告警 | `USAGE_ALERT_THRESHOLD`（默认 80000）+ `migration-usage.sql` | 当日请求数越过阈值时给所有管理员发一封邮件，每个 UTC 日最多一封 |

**用量是近似值**：计数在 Worker 内存累加、每 200 次请求或每 60 秒汇总落盘一次（把 D1 写放大压到 0.5% 以内），isolate 被回收时未落盘的计数会丢，实际用量通常**略高于**表中数字。作为告警信号足够，但不要当账单用。

管理员可在面板「管理后台 → 反向代理用量」查看近 14 天，或直接调 `GET /api/admin/usage`。

需要扩容时：**Workers Paid 是 $5 USD/月起**（按账号，含 1000 万请求/月，超出 $0.30/百万；CPU 超出 $0.02/百万 ms），**带宽仍然免费**。D1 若升级：行读 250 亿/月含在内（超出 $0.001/百万）、行写 5000 万/月（超出 $1.00/百万）、存储超 5 GB 后 $0.75/GB-月。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 管理面板 |
| POST | `/api/login` | 登录（发放的账号） |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 当前用户 |
| GET | `/api/records` | 我的记录 |
| POST | `/api/records` | 创建/更新 `{subdomain, type, value}` |
| DELETE | `/api/records/:id` | 删除记录 |
| POST | `/api/slots/:id/record` | 设置/更新该卡槽的 DNS 记录 |
| DELETE | `/api/slots/:id/record` | 删除该卡槽的 DNS 记录 |
| POST | `/api/slots/:id/proxy` | 开启/更新反代，`{target:"https://x.y.workers.dev"}` |
| DELETE | `/api/slots/:id/proxy` | 关闭反代 |
| POST | `/api/admin/users` | 管理员建号（Bearer ADMIN_PASSWORD） |
| GET | `/api/admin/usage` | 管理员查看反代用量（近 14 天）与缓存/限流配置 |

## 目录结构

```
fblog-dns/
├── wrangler.jsonc        # Worker 配置（D1/Assets 绑定、ROOT_DOMAIN）
├── schema.sql            # D1 表结构
├── migration-*.sql       # 增量迁移（已有库按需执行；全新安装只需 schema.sql）
├── public/
│   └── index.html        # 前端单页（静态资源，经 env.ASSETS 提供）
├── src/
│   ├── index.ts          # 路由与业务逻辑
│   ├── auth.ts           # PBKDF2 密码哈希 + HMAC 会话
│   ├── validate.ts       # 子域名/记录值校验、保留字
│   └── cloudflare.ts     # Cloudflare DNS API 封装
├── scripts/
│   └── smoke-test.ps1    # 本地端到端冒烟测试
└── .dev.vars.example     # 本地开发配置模板
```

## 本地测试

```bash
npx wrangler dev --port 8787   # 先复制 .dev.vars.example 为 .dev.vars 并填测试值
pwsh -File scripts\smoke-test.ps1
```

## 开发提示（重要）

入口 `fetch()` 里的 handler 调用**必须写 `return await handler(...)`** 而不能只写
`return handler(...)`：后者把 Promise 直接返回，若 handler 拒绝，rejection 发生在
try/catch 之外，会变成整个 Worker 的未捕获异常（表现为 500 + 原始堆栈），
前端会收到无意义的报错。所有内部会抛错的调用（`withCf`、`requireUser` 等）
同理需要在 await 内被捕获。
