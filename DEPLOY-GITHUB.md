# GitHub 自动部署指南（push 即部署）

用 GitHub Actions 实现：代码推到 `main` 分支，自动执行类型检查和 `wrangler deploy`，
把最新版本部署到 Cloudflare Workers。之后你在任何机器上改代码 → push → 自动上线。

```
本地编辑 → git push → GitHub Actions
                          ├── npm ci
                          ├── npm run typecheck
                          └── npx wrangler deploy → Cloudflare Workers（即时生效）
```

---

## 1. 提前准备

- 一个 [GitHub](https://github.com) 账号；
- 本项目已初始化好本地 git 仓库（含 `.github/workflows/deploy.yml`）；
- `wrangler.jsonc` 里的 D1 `database_id` 必须已经是真实值（本项目已填好）。

## 2. 创建「CI 专用」API Token（与现有 DNS Token 不同）

> 现有的 Token 只有 `Zone → DNS → Edit` 权限，**不能**用于部署 Worker；
> 需要单独建一个带 Workers 写权限的。

1. Cloudflare 控制台 → 头像 → **My Profile** → **API Tokens** → **Create Token**；
2. 选模板 **Edit Cloudflare Workers**（或手动建），权限按需加：
   - Account → **Workers Scripts** → **Edit**
   - Account → **D1** → **Edit**（保险起见，避免部署时校验 D1 绑定失败）
   - Account → **Account Settings** → **Read**
   - User → **Memberships** → **Read**
   - Zone Resources 可保持默认账号级（部署 Worker 需要账号级）；若可选，授权 `fblog.cyou` 所在账号即可
3. 创建后**立即复制保存**（只显示一次）。这就是 `CLOUDFLARE_API_TOKEN`。

## 3. 找到你的 Cloudflare 账号 ID

Cloudflare 控制台 → **Workers & Pages** 概览页 → 右侧 **Account ID**（一长串 hex）。
这就是 `CLOUDFLARE_ACCOUNT_ID`。

## 4. 在 GitHub 建仓库并推送

方式 A（网页）：

1. GitHub → **New repository** → 名字填 `fblog-dns`（可私有，Actions 免费额度够用）；
2. 建好后按第 6 步加 Secrets，再复制仓库地址；
3. 本地执行：

```bash
cd C:\Users\18175\Desktop\a\fblog-dns
git remote add origin <你的仓库地址，如 https://github.com/你的用户名/fblog-dns.git>
git branch -M main
git push -u origin main
```

方式 B（命令行 `gh`）:

```bash
cd C:\Users\18175\Desktop\a\fblog-dns
gh repo create fblog-dns --private --source=. --remote=origin --push
```

推送成功后，GitHub → 仓库 → **Actions** 标签页应能看到 `Deploy fblog-dns Worker` 在跑。

## 5. 配置两个 GitHub Secrets

GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

| Secret 名 | 值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 第 2 步创建的 CI Token |
| `CLOUDFLARE_ACCOUNT_ID` | 第 3 步的账号 ID |

> ⚠️ Worker 自身的 4 个密钥（`CF_API_TOKEN` 等）**不用**放进 GitHub——
> 它们存在 Cloudflare Worker 上，重新部署不会丢。
> 只有在「新账号换机器重跑 `wrangler secret put`」时才需要再设置一次。

## 6. 验证流水线

1. 推送后等 1~2 分钟，Actions 里状态变绿；
2. 打开 `https://fblog-dns.<你的子域>.workers.dev`（或自定义域名）确认页面正常；
3. 本地改一行代码（比如 `src/index.ts` 里的 MAX_RECORDS_PER_USER）→ `git add . && git commit -m "x" && git push`，
   观察 Actions 自动重新部署。

## 7. 日常开发流程（之后都这样干）

```bash
# 改代码 → 本地快速验证（可选）→ 推送上线
npm run typecheck          # 静态检查
npx wrangler dev           # 本地起服务测试（可选）
git add -A
git commit -m "改了啥"
git push                   # 自动部署
```

## 注意事项

- `.dev.vars`、`.wrangler/`、`node_modules/`、`dist/` 已在 `.gitignore` 里，**不会**被推到 GitHub；
- `npm ci` 依赖 `package-lock.json`（已随项目提交）；
- 若要「只有通过审核的 PR 才部署」，把 workflow 的触发改为 `pull_request` 分支保护模式（进阶，默认不需要）；
- Actions 有免费额度（私有仓库每月 2000 分钟），本项目一次部署约 1 分钟，完全够用。