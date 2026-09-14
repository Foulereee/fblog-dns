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

## 六、上线后的安全清单（务必做）

- [ ] 在 Cloudflare **Security → WAF → Rate limiting rules** 加两条免费规则：保护 `/api/login`（如 10 次/分钟/IP）和 `/api/records`（如 30 次/小时/IP）；
- [ ] 确认 API Token 只授权了 `fblog.cyou` 一个 zone；
- [ ] `ADMIN_PASSWORD` 与 `SESSION_SECRET` 使用长随机值，勿复用；
- [ ] 定期检查记录：`npx wrangler d1 execute fblog-dns-db --remote --command "SELECT * FROM records"`，删除僵尸记录；
- [ ] 扩展保留字表：`src/validate.ts` 的 `RESERVED_SUBDOMAINS`；
- [ ] 如面向公众开放，补齐正式的 TOS/AUP 页面与滥用举报入口（滥用者会把整个 fblog.cyou 拖下水，甚至触发注册局对整域名的处置）。

## 免费额度参考（2025 年起）

| 项目 | 免费额度 |
| --- | --- |
| Workers | 10 万请求/天 |
| D1 | 500 万行读/天、10 万行写/天、共 5 GB 存储 |
| Cloudflare DNS | 无限记录、全球 anycast |

你的量级（几十到几百个子域名）完全在免费额度内。

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
| POST | `/api/admin/users` | 管理员建号（Bearer ADMIN_PASSWORD） |

## 目录结构

```
fblog-dns/
├── wrangler.jsonc        # Worker 配置（D1/Assets 绑定、ROOT_DOMAIN）
├── schema.sql            # D1 表结构
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
