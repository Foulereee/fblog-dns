# fblog.cyou 二级域名分发平台 · 部署文档

> 目标：把域名 **fblog.cyou** 的 DNS 托管迁到 Cloudflare，用 `fblog-dns` 这个 Worker
> （Cloudflare Workers + D1）搭建一个免费二级域名分发平台。本文按阶段推进，每阶段都有
> **验证命令**，做完一步确认一步。
>
> 预计耗时：NS 迁移等待 10 分钟 ~ 数小时，其余步骤 5~10 分钟。
>
> 📌 **本项目当前状态（2026-09）**：平台已上线并端到端验证通过，
> 访问地址为 **https://dns.fblog.cyou**（自定义域名），已绑定 `dns.fblog.cyou` → Worker。
> 注意：本账号的 `*.workers.dev` 子域名在 Cloudflare 边缘存在**账号级 1101 故障**
> （与代码无关，连零绑定 hello-world Worker 也 1101），因此**一律使用自定义域名**访问，
> workers.dev 地址可忽略。

---

## 0. 前置条件

| 项目 | 要求 |
| --- | --- |
| 域名 | `fblog.cyou` 已注册在 [Spaceship](https://www.spaceship.com/) 并正常续费 |
| Cloudflare 账号 | 在 [dash.cloudflare.com](https://dash.cloudflare.com/) 注册（免费） |
| 本地环境 | Windows / macOS / Linux 均可；已装 **Node.js 18+** 和 npm |
| 本代码 | 已拿到 `fblog-dns/` 项目目录（含 `src/`、`public/`、`schema.sql`、`wrangler.jsonc`） |

> 免费额度参考：Workers 10 万次请求/天、D1 每日 500 万行读 + 10 万行写 + 共 5GB 存储、
> DNS 记录无限。本平台的规模完全在免费额度内。

---

## 1. 阶段一：把 fblog.cyou 的 NS 迁到 Cloudflare（一次性，全网生效核心步骤）

平台的所有 DNS 记录都是通过 Cloudflare API 自动创建的，所以**域名必须由 Cloudflare 托管**。

### 1.1 在 Cloudflare 添加站点

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com/)；
2. 点 **Add a site**，输入 `fblog.cyou`，套餐选 **Free**；
3. Cloudflare 会尝试从旧 NS（Spaceship）**自动扫描复制现有 DNS 记录**，确认记录列表后点击继续；
4. 进入「Change your nameservers」页面，页面上会给出**两个 nameserver**，形如：
   ```
   abc123.ns.cloudflare.com
   def456.ns.cloudflare.com
   ```
   **先别关这个页面**，下一步要去 Spaceship 修改。

### 1.2 在 Spaceship 修改 Nameserver

方式 A（网页，推荐）：

1. 登录 [Spaceship](https://www.spaceship.com/) → **Domains** → 选择 `fblog.cyou`；
2. 找到 **Nameservers / DNS** 设置，选择「Custom nameservers」（自定义），
   填入 1.2 拿到的两个 `xxx.ns.cloudflare.com` / `yyy.ns.cloudflare.com`，保存。

方式 B（Spaceship API，可选）：

```bash
curl -X PUT "https://spaceship.dev/api/v1/domains/fblog.cyou/nameservers" \
  -H "X-API-Key: <你的Spaceship API Key>" \
  -H "X-API-Secret: <你的Spaceship API Secret>" \
  -H "Content-Type: application/json" \
  -d '{"nameservers":["abc123.ns.cloudflare.com","def456.ns.cloudflare.com"]}'
```

### 1.3 验证 NS 生效

```bash
dig NS fblog.cyou
nslookup -type=ns fblog.cyou
```

输出应包含两个 Cloudflare 的 NS，且**不再出现 Spaceship 的 NS**。生效时间通常几分钟到几小时。

> ⚠️ NS 切换后，fblog.cyou 的所有 DNS 记录改由 Cloudflare 管理；原来在 Spaceship 的解析不再生效。
> 到 Cloudflare 控制台确认已自动导入的记录（A/AAAA/MX/TXT 等，尤其是邮箱用的 MX 记录）。

---

## 2. 阶段二：创建最小权限 API Token 并记录 Zone ID

1. Cloudflare 控制台右上角头像 → **My Profile** → **API Tokens** → **Create Token**；
2. 选模板 **Edit zone DNS**：
   - **Permissions**：Zone → DNS → **Edit**（可再加一条 Read）；
   - **Zone Resources**：选择 **Specific zone → fblog.cyou**（务必只授权这一个域名，缩小泄露影响面）；
3. 点 **Continue to summary → Create Token**；
4. **立刻复制保存 Token**（只显示这一次）。这就是 `CF_API_TOKEN`；
5. 回到 fblog.cyou 的 **Overview** 页面，右侧 **API** 区域有 **Zone ID**，复制保存。这就是 `CF_ZONE_ID`。

> 需要保存的 4 个敏感值，后面配 secrets 要用：
> `CF_API_TOKEN`、`CF_ZONE_ID`、`ADMIN_PASSWORD`（自己设的长随机口令）、
> `SESSION_SECRET`（`openssl rand -hex 32` 生成）。

---

## 3. 阶段三：本地部署并上线

在**项目目录** `fblog-dns/` 下执行（Windows 用 PowerShell，macOS/Linux 用终端）。

### 3.1 安装依赖

```bash
npm install
```

### 3.2 登录 Cloudflare（wrangler 需要授权）

```bash
npx wrangler login
```

浏览器会自动打开，确认授权即可。（无浏览器环境可用 `npx wrangler login --browser=false` 手动粘贴链接。）

### 3.3 创建 D1 数据库

```bash
npm run db:create
```

输出类似：

```
✅ Created D1 database 'fblog-dns-db' at
📍 d1:<uuid>
```

把输出中的 `database_id`（UUID）填进 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "fblog-dns-db",
    "database_id": "把这里替换为上面输出的UUID"
  }
]
```

### 3.4 初始化数据库表（建 users / records 表）

```bash
npm run db:init
```

执行成功会显示 4 条 SQL 命令执行结果。

### 3.5 写入 4 个敏感配置（每个命令会交互式提示输入）

```bash
npx wrangler secret put CF_API_TOKEN     # 粘贴阶段二的 Token
npx wrangler secret put CF_ZONE_ID       # 粘贴阶段二的 Zone ID
npx wrangler secret put ADMIN_PASSWORD   # 输入你自己设的长随机口令（创建用户时用）
npx wrangler secret put SESSION_SECRET   # openssl rand -hex 32，或任意 32 字节随机串
```

> 本地调试时这些值放 `.dev.vars`（把 `.dev.vars.example` 复制改名并填充，不提交 git）。
> 线上环境以 `secret put` 的值为准。

### 3.6 本地先跑一遍（推荐，验证代码没问题）

```bash
npm run dev
# 浏览器打开 http://127.0.0.1:8787 应看到登录页
# 另开一个终端跑自动化冒烟测试（可选）：
pwsh -File scripts\smoke-test.ps1
```

确认页面正常后 `Ctrl+C` 停掉。

### 3.7 上线

```bash
npm run deploy
```

输出会给出 Worker 地址：

```
https://fblog-dns.<你的子域>.workers.dev
```

把它记下来，下一步创建用户要用。

### 3.8 验证线上

浏览器打开 `https://fblog-dns.<你的子域>.workers.dev`，确认：
- 页面正常渲染（深色主题的登录面板）；
- 未登录时访问 `/api/records` 返回 `{"error":"请先登录"}`（可在浏览器开发者工具里看）。

---

## 4. 阶段四：创建第一个用户（管理员发放账号）

平台不开放注册，账号由管理员通过下面的命令发放。

**方式 A：Git Bash / macOS / Linux**

```bash
curl -X POST https://fblog-dns.<你的子域>.workers.dev/api/admin/users \
  -H "Authorization: Bearer <你的ADMIN_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"至少8位的密码"}'
```

**方式 B：Windows PowerShell**

```powershell
$body = @{ username = 'alice'; password = '至少8位的密码' } | ConvertTo-Json
Invoke-RestMethod -Uri "https://fblog-dns.<你的子域>.workers.dev/api/admin/users" `
  -Method Post -Headers @{ Authorization = "Bearer <你的ADMIN_PASSWORD>" } `
  -ContentType 'application/json' -Body $body
```

成功返回：`{"ok":true,"username":"alice"}`。把用户名密码发给用户即可登录使用。

> 重复创建同一用户会返回 409「用户名已存在」。密码至少 8 位。

---

## 5. 阶段五（推荐）：绑定自己的域名访问面板

让用户访问 `https://dns.fblog.cyou` 而不是 `.workers.dev`：

1. Cloudflare 控制台 → fblog.cyou → **Workers Routes**（或进入 `fblog-dns` Worker →
   **Settings → Domains → Add Custom Domain**）；
2. 添加 `dns.fblog.cyou` 指向 `fblog-dns`；
3. 等待 Cloudflare 自动创建 CNAME 记录并签发 HTTPS 证书（几分钟）；
4. 验证：`dig CNAME dns.fblog.cyou` 应指向该 Worker，浏览器访问 `https://dns.fblog.cyou` 正常；
5. 之后创建用户的命令里，把地址换成 `https://dns.fblog.cyou/api/admin/users`。

---

## 6. 阶段六：上线后安全清单（务必逐条做）

- [ ] **WAF 限流**：Cloudflare 控制台 → fblog.cyou → **Security → WAF → Rate limiting rules**，
      免费档加两条规则：`/api/login`（如 10 次/分钟/IP）、`/api/records`（如 30 次/小时/IP）；
- [ ] 确认 API Token **只授权了 fblog.cyou 一个 zone**；
- [ ] `ADMIN_PASSWORD`、`SESSION_SECRET` 用长随机值，且与线上部署后立即生效（secret put 后无需重启，自动热加载）；
- [ ] 定期审计记录：`npx wrangler d1 execute fblog-dns-db --remote --command "SELECT * FROM records"`，
      清理僵尸记录；
- [ ] 按需扩充保留字：`src/validate.ts` 的 `RESERVED_SUBDOMAINS`；
- [ ] 面向公众开放前，准备正式的 **TOS / AUP** 页面和**滥用举报入口**
      （滥用者可能把整个 fblog.cyou 拖下水，甚至触发注册局对整域名的处置）。

---

## 7. 常用维护命令

```bash
# 查看已部署版本 / 重新部署
npx wrangler deploy

# 查看线上记录
npx wrangler d1 execute fblog-dns-db --remote --command "SELECT * FROM records"

# 删除违规用户的全部记录
npx wrangler d1 execute fblog-dns-db --remote --command \
  "DELETE FROM records WHERE user_id = (SELECT id FROM users WHERE username='xxx')"

# 删除用户（级联删除其记录）
npx wrangler d1 execute fblog-dns-db --remote --command \
  "DELETE FROM users WHERE username='xxx'"

# 修改配额：编辑 src/index.ts 顶部 MAX_RECORDS_PER_USER 后 npx wrangler deploy
```

---

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `dig NS` 还是旧 NS | NS 切换有传播延迟（几分钟~数小时），耐心等待；确认 Spaceship 页面已保存 |
| 建记录报 `502 DNS 查询/写入失败：Could not route ... object identifier is invalid` | `CF_ZONE_ID` 填错或 `CF_API_TOKEN` 权限不足：核对 Zone ID（Overview 右侧），重新创建只授权该 zone 的 Token |
| `502 ... invalid request headers / Authentication error` | `CF_API_TOKEN` 错误，重新 `npx wrangler secret put CF_API_TOKEN` |
| 登录报「服务端未配置完成，缺少环境变量」 | 四个 secret 未全部配置：补 `wrangler secret put` |
| 建记录报 `no such table: users` | D1 表未初始化：`npm run db:init` |
| 用户登录 401 | 账号未创建：先执行阶段四建号 |
| 删除他人记录报 404「记录不存在或无权操作」 | 正常，平台做了越权隔离 |
| 前缀被拒（保留字） | `www`、`api`、`mail` 等为平台保留，换一个前缀 |
| 记录 400 各类校验错误 | 按提示修改：IPv4 每段 ≤255、AAAA 需合法 IPv6、CNAME 不能指向本域名自身、不能带 http:// |
| Windows 本地 dev 报文件被占用 / 热重载异常 | 结束多余的 node/workerd 进程，**只保留一个** `wrangler dev` 实例（多个实例会互相抢文件） |

---

## 9. 一次部署完整命令速览

```bash
cd fblog-dns
npm install
npx wrangler login
npm run db:create          # 把输出的 database_id 填进 wrangler.jsonc
npm run db:init
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
# 然后发第一个账号：
# curl -X POST https://fblog-dns.<子域>.workers.dev/api/admin/users \
#   -H "Authorization: Bearer <ADMIN_PASSWORD>" -H "Content-Type: application/json" \
#   -d '{"username":"alice","password":"密码"}'
```