# X友跨翻车列表

> 一个基于 **Cloudflare Workers + D1** 的「X（Twitter）好友翻车记录」展示与审核系统。
> 任何人（游客）都可以匿名提交「新增条目 / 修改条目」建议（由 Cloudflare Turnstile 人机验证保护），
> 审核员 / 超级管理员在后台统一审核；通过后才真正写入公开列表。

---

## Demo

在线 demo: https://star-timeline-demo.00910721.xyz/

> 若演示站使用内置 Mock（见 [Mock 演示环境](#mock-演示环境)），
> 超级管理员密码为 `admin888`，审核员为 `审核员甲 / reviewer1`、`审核员乙 / reviewer2`。

![p1](docs/image.png)
![p2](docs/image-1.png)
![p3](docs/image-2.png)
![p4](docs/image-3.png)

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [角色与权限](#角色与权限)
- [技术架构](#技术架构)
- [目录结构](#目录结构)
- [快速部署](#快速部署)
- [配置说明](#配置说明)
- [API 概览](#api-概览)
- [安全设计](#安全设计)
- [冒烟测试](#冒烟测试)
- [常见问题](#常见问题)

---

## 项目简介

**X友跨翻车列表**用来记录群友在 X（Twitter）上的各类「翻车」瞬间：

- 前台按**翻车日期所属月份**分组展示全部条目：头像、昵称、X 用户名、翻车日期、翻车详情、标签、跳转 X 主页；
- **任何人都可以提交**新增／修改建议（不需要注册、不需要实名），由 Cloudflare Turnstile 拦截机器人；
- 提交进入后台待审队列，审核员 / 超级管理员可**通过 / 驳回（驳回必填理由）**，通过后自动应用变更；
- 权限分级：**审核员**只能审核建议；**超级管理员**额外可查看审核记录、管理审核员名单、直接管理条目。

整个系统只需要一个 Cloudflare Worker 即可承载静态页面 + API + 数据库，零服务器运维成本。

> ⚠️ 与旧版「社团成员时间线」不兼容：已移除**真实姓名验证**与**届别**，数据库表结构需重建（见 [快速部署](#快速部署)）。

## 功能特性

### 前台（公开）

- ✅ 条目列表展示：按月分组、标签筛选、点击卡片展开详情
- ✅ 展开卡片显示 X 用户名与「在 X 查看」跳转按钮
- ✅ 任何游客均可提交「新增条目 / 修改条目」建议
- ✅ 头像自动反向代理：`pbs.twimg.com` 等境外图床在境内访问受限，自动改走 Worker 代理加载
- ✅ Cloudflare Turnstile 人机验证（未配置时自动跳过，便于本地开发）
- ✅ 表单内置「如何用 F12 获取头像链接」提示

### 后台

- ✅ 统一密码登录：同一个入口自动识别**超级管理员**或**审核员**
- ✅ 2 小时会话有效期，支持服务端吊销；退出登录
- ✅ 待审核 / 已通过 / 已驳回 三栏队列，显示变更 diff、类型（新增 / 修改）与驳回理由
- ✅ 一键通过 / 驳回（驳回必填理由）
- ✅ **超级管理员专属**：审核记录（审计日志）、审核员管理（增删改）、条目直接管理（立即生效）

### 安全

- ✅ 字段白名单 + 类型校验，越权字段（如 `id`）直接拒绝
- ✅ Turnstile 服务端校验（`TURNSTILE_SECRET_KEY`）
- ✅ D1 计数窗口限流（登录 5 次/分钟、提交 10 次/小时，超限 429）
- ✅ 64KB 请求体上限、URL 协议合法性校验（仅 http/https）
- ✅ 审核员密码使用 PBKDF2-SHA256（10 万轮 + 随机盐）慢哈希存储
- ✅ 审计日志记录登录、审核与全部管理操作

## 角色与权限

| 角色 | 鉴权方式 | 能力 |
| --- | --- | --- |
| 游客（任何人） | 无 | 查看条目列表、提交新增 / 修改建议（需 Turnstile） |
| 审核员 | `adminToken`（Bearer，2h） | 阅读建议、通过 / 驳回 |
| 超级管理员 | `adminToken`（Bearer，2h） | 审核员全部能力 + 审核记录 / 审核员管理 / 条目直接管理 |

> 💡 没有注册体系。超级管理员密码来自环境变量 `ADMIN_PASSWORD`；审核员账号存在数据库 `reviewers` 表中。
> 登录接口会先尝试超级管理员密码，再依次比对各审核员的密码哈希，命中即确定身份与角色。

## 技术架构

| 层 | 技术 |
| --- | --- |
| 运行时 | Cloudflare Workers |
| 数据库 | Cloudflare D1（SQLite） |
| 静态资源 | Workers Assets（`./content` 目录，无构建步骤） |
| 人机验证 | Cloudflare Turnstile |
| 密码学 | Web Crypto：PBKDF2-SHA256（审核员密码哈希）、安全随机令牌 |
| 身份凭证 | `adminToken`（Bearer，2 小时，落库可吊销） |

## 目录结构

```
.
├── src/
│   └── index.js          # Worker 入口：路由 + 全部 API 实现
├── content/
│   └── index.html        # 前台 + 后台单页应用（无构建步骤）
├── schema.sql            # D1 建表脚本（会 DROP 旧表后重建）
├── wrangler.toml         # Wrangler 配置
├── API.md                # 完整 API 文档
└── README.md
```

## 快速部署

### 1. 安装 Wrangler

```bash
npm i -g wrangler
# 或在项目中：
npm init -y && npm i -D wrangler
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create you_are_mtf_db
```

将返回的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "you_are_mtf_db"
database_id = "<替换为你实际的 database_id>"
```

### 3. 初始化表结构

> ⚠️ `schema.sql` 会先 `DROP TABLE` 再重建，**会清空数据**，请确认后再执行。

```bash
npx wrangler d1 execute you_are_mtf_db --remote --file=./schema.sql
```

### 4. 配置 Secrets

```bash
npx wrangler secret put ADMIN_PASSWORD        # 超级管理员密码（必填）
npx wrangler secret put TURNSTILE_SECRET_KEY  # Turnstile 私钥（可选，未配置则跳过人机验证）
npx wrangler secret put TURNSTILE_SITE_KEY    # Turnstile 站点公钥（可选，会下发给前端）
```

> `ADMIN_PASSWORD` 未配置时无法以超级管理员身份登录（返回 `401 PASSWORD_WRONG`；审核员账号仍可正常登录）。
> Turnstile 密钥可在 Cloudflare Dashboard → Turnstile 中创建；也可以把 `TURNSTILE_SITE_KEY` 写进 `wrangler.toml` 的 `[vars]`。
> 本地开发若不需要人机验证，可以完全不配置这两个 Turnstile 变量。

### 5. 部署上线

```bash
npx wrangler deploy
```

完成后访问 `https://<your-worker>.workers.dev/` 即为主页，`/#/admin` 为后台。

## 配置说明

### wrangler.toml 关键项

| 配置项 | 说明 |
| --- | --- |
| `main = "src/index.js"` | Worker 入口文件 |
| `assets = { directory = "./content" }` | 静态资源目录，前端 SPA 所在处 |
| `compatibility_date` | 兼容日期 |
| `d1_databases.binding = "DB"` | 代码中通过 `env.DB` 访问数据库 |

### 环境变量 / Secrets

| 名称 | 必填 | 用途 |
| --- | :---: | --- |
| `ADMIN_PASSWORD` | ✓ | 超级管理员明文密码（服务端恒时比较） |
| `TURNSTILE_SECRET_KEY` | ✗ | Turnstile 服务端校验私钥；**未配置时不校验人机验证** |
| `TURNSTILE_SITE_KEY` | ✗ | Turnstile 站点公钥，经 `GET /api/config` 下发给前端渲染控件 |

## API 概览

所有响应统一包格式：

```jsonc
// 成功
{ "ok": true,  "data": { ... } }
// 失败
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

### 公开接口

| 方法 | 路径 | 说明 | 限流 |
| --- | --- | --- | --- |
| GET | `/api/config` | 前端获取 Turnstile 开关与站点公钥 | — |
| GET | `/api/avatar?u=` | 头像反向代理：回源 `pbs.twimg.com` 等被墙图床（返回图片二进制，非 JSON） | — |
| GET | `/api/members` | 获取全部条目（空库返回 `[]`） | — |
| POST | `/api/submissions` | 提交新增 / 修改建议（需 Turnstile，若已配置） | 10 次/小时/IP |

#### 示例：提交新增条目

```json
POST /api/submissions
{
  "type": "create",
  "changes": {
    "username": "@elonmusk",
    "name": "马斯克",
    "crashDate": "2025-05-20",
    "bio": "把 X 改成 Y 又改回来",
    "avatar": "https://pbs.twimg.com/...",
    "tags": ["口嗨", "打脸"]
  },
  "turnstileToken": "0.xxxx"
}
→ { "ok": true, "data": { "submissionId": 42 } }
```

#### 示例：提交修改建议

```json
POST /api/submissions
{
  "type": "update",
  "memberId": 3,
  "changes": { "crashDate": "2025-05-22", "bio": "补充新的细节" },
  "turnstileToken": "0.xxxx"
}
```

字段白名单：`username / name / crashDate / bio / avatar / tags`。
`create` 必填 `username / name / crashDate`。提交白名单外字段（如 `id`）会被拒绝（`FIELD_FORBIDDEN`）。

### 管理接口（除 login 外均需 `Authorization: Bearer <adminToken>`）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | :---: | --- |
| POST | `/api/admin/login` | 公开 + 限流 | 统一密码登录，返回 `adminToken / role / identity / expiresAt` |
| GET | `/api/admin/me` | 审核员+ | 返回当前会话 `{ role, identity }` |
| GET | `/api/admin/submissions?status=` | 审核员+ | 列出建议（默认 `pending`） |
| POST | `/api/admin/submissions/{id}/approve` | 审核员+ | 通过并应用变更 |
| POST | `/api/admin/submissions/{id}/reject` | 审核员+ | 驳回，**必须携带非空 `reason`** |
| GET | `/api/admin/audit?limit=` | 超级管理员 | 审核 / 审计记录（最新在前，`limit` ≤ 500） |
| GET | `/api/admin/reviewers` | 超级管理员 | 审核员列表 |
| POST | `/api/admin/reviewers` | 超级管理员 | 新增审核员（`name` + `password`≥6 位） |
| PUT | `/api/admin/reviewers/{id}` | 超级管理员 | 修改审核员名称 / 密码 |
| DELETE | `/api/admin/reviewers/{id}` | 超级管理员 | 删除审核员并吊销其会话 |
| GET | `/api/admin/members` | 超级管理员 | 条目列表（管理端） |
| POST | `/api/admin/members` | 超级管理员 | 新增条目（立即生效） |
| PUT | `/api/admin/members/{id}` | 超级管理员 | 修改条目（立即生效，部分更新） |
| DELETE | `/api/admin/members/{id}` | 超级管理员 | 删除条目并作废其待审建议 |

### 主要错误码速查

| code | HTTP | 含义 |
| --- | :---: | --- |
| `PARAM_MISSING` | 400 | 缺少参数或请求体不合法 |
| `FIELD_MISSING` | 400 | 缺少必填字段 |
| `FIELD_INVALID` | 400 | 字段格式不正确 |
| `FIELD_FORBIDDEN` | 400 | 字段不允许提交 / 修改 |
| `CHANGES_EMPTY` | 400 | 没有检测到修改内容 |
| `REASON_REQUIRED` | 400 | 驳回缺少理由 |
| `TURNSTILE_FAILED` | 400 | 人机验证失败或缺失 |
| `PASSWORD_WRONG` | 401 | 密码错误 |
| `ADMIN_TOKEN_INVALID` | 401 | 未登录或会话失效 |
| `FORBIDDEN` | 403 | 权限不足（如审核员访问超管接口） |
| `NOT_FOUND` | 404 | 记录 / 未知路由不存在 |
| `MEMBER_NOT_FOUND` | 404 | 条目不存在 |
| `REVIEWER_NOT_FOUND` | 404 | 审核员不存在 |
| `REVIEWER_EXISTS` | 409 | 审核员名称已存在 |
| `ALREADY_REVIEWED` | 409 | 审核记录已处理 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `BODY_TOO_LARGE` | 413 | 请求体超过 64KB |
| `INTERNAL_ERROR` | 500 | 服务端异常（兜底） |

## 安全设计

- **密码存储**：审核员密码使用 PBKDF2-SHA256（10 万轮 + 16 字节随机盐），格式 `pbkdf2$轮数$盐$摘要`；超级管理员密码来自环境变量，恒时比较；
- **令牌体系**：`admin_sessions` 落 D1，`adminToken` 支持吊销；删除审核员时同步吊销其会话；过期会话惰性清理；
- **人机验证**：`POST /submissions` 在配置 `TURNSTILE_SECRET_KEY` 时强制校验 Turnstile；校验失败返回 `TURNSTILE_FAILED`；
- **限流**：D1 计数窗口实现，`admin/login` 5 次/分钟、`submissions` 10 次/小时；
- **输入校验**：请求体 ≤ 64KB；字段白名单 + 类型校验；URL 仅允许 http/https（裸域名自动补 `https://`），其他协议（如 `javascript:`）一律拒绝；用户名规范化（去 `@` / URL 前缀，统一小写，`^[a-z0-9_]{1,15}$`）；
- **越权防护**：`/admin/audit`、`/admin/reviewers`、`/admin/members` 仅超级管理员可用，审核员访问返回 `FORBIDDEN`；
- **删除级联原子性**：依赖 D1 `batch()` 的隐式事务，先作废 pending 建议再删行，杜绝悬空审核记录。

## 冒烟测试

```bash
BASE=https://<your-worker>.workers.dev

# 1) 公开配置 & 列表（列表初始应为 {"ok":true,"data":[]}）
curl -s $BASE/api/config
curl -s $BASE/api/members

# 2) 登录拿 token（超级管理员；服务端配置了 Turnstile 时需追加有效 turnstileToken）
TOK=$(curl -s $BASE/api/admin/login -X POST \
  -H 'Content-Type: application/json' \
  -d '{"password":"你的超级管理员密码"}' | jq -r .data.adminToken)

# 3) 游客提交新增建议（Turnstile 未配置时可省略 turnstileToken）
SID=$(curl -s $BASE/api/submissions -X POST \
  -H 'Content-Type: application/json' \
  -d '{"type":"create","changes":{"username":"elonmusk","name":"马斯克","crashDate":"2025-05-20","tags":["口嗨"]}}' \
  | jq -r .data.submissionId)

# 4) 审核队列 → 通过
curl -s "$BASE/api/admin/submissions?status=pending" -H "Authorization: Bearer $TOK"
curl -s -X POST "$BASE/api/admin/submissions/$SID/approve" -H "Authorization: Bearer $TOK"

# 5) 新增审核员并登录
curl -s $BASE/api/admin/reviewers -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"name":"审核员甲","password":"reviewer1"}'
curl -s $BASE/api/admin/login -X POST -H 'Content-Type: application/json' \
  -d '{"password":"reviewer1"}'

# 6) 访问主页
open $BASE/
```

## 常见问题

**Q1：忘记超级管理员密码怎么办？**

重新注入即可覆盖：`npx wrangler secret put ADMIN_PASSWORD`，已发出的 `adminToken` 不受影响，无需重启 Worker。

**Q2：审核员密码忘了怎么办？**

由超级管理员在后台「审核员管理」中编辑该审核员、填写新密码保存即可（需 ≥6 位）。

**Q3：为什么本地不需要过 Turnstile？**

未配置 `TURNSTILE_SECRET_KEY` 时后端跳过人机验证，`GET /api/config` 也会告诉前端 `turnstileEnabled=false`。上线务必配置两把 Turnstile 密钥。配置后，**后台登录**与**游客提交**都会强制校验（后台登录因此可防暴力破解）。

**Q4：同一个 X 用户翻车多次怎么办？**

用户名**不做唯一约束**，允许同一 `username` 存在多条条目（不同翻车日期）。

**Q5：并发同时 approve 多个 pending 建议会怎样？**

按审核先后逐个应用，后审覆盖先审（last-write-wins），不做冲突检测；若目标条目已被删除，approve 返回 `404 MEMBER_NOT_FOUND` 拒绝应用。

**Q6：本地开发？**

创建 `.dev.vars`，写入：

```
ADMIN_PASSWORD=aaaaa
```

然后：

```bash
npx wrangler dev                # 本地起 Worker + 本地模拟 D1/Assets
npx wrangler d1 execute you_are_mtf_db --local --file=./schema.sql   # 本地初始化表
```

> 旧版使用的 `SERVER_PEPPER` 已不再需要，可安全删除。

## Mock 演示环境

前端内置 Mock 后端（`content/index.html` 中 `const USE_MOCK = true`），无需真实后端即可演示全流程：

- **超级管理员密码：** `admin888`
- **内置审核员：** `审核员甲 / reviewer1`、`审核员乙 / reviewer2`
- 内置 8 条示例条目；提交建议、审核、审核员管理、条目管理全部可用（数据存在内存，刷新即重置）

接入真实后端：把 `USE_MOCK` 改为 `false` 后重新部署即可（或直接 `wrangler deploy`）。

---

License · 只做热爱的事，让每一次翻车都有据可查 ✦
