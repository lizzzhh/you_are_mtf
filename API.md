# X友跨翻车列表系统 · API 文档

| 项目         | 内容                                                                  |
| ------------ | --------------------------------------------------------------------- |
| **文档版本** | v2.0                                                                  |
| **更新日期** | 2026-10-11                                                            |
| **适用范围** | 前台翻车列表、匿名提交（新增 / 修改）建议、后台审核、审核员与条目管理 |
| **约定基准** | 与前端实现（`content/index.html` 的 `apiFetch`）严格对齐              |

> ⚠️ 本文档描述 **v2 系统**。与旧版「社团成员时间线」不兼容：已移除**真实姓名验证**与**届别**，新增 **X 用户名**、**翻车日期**、**Cloudflare Turnstile 人机验证**、**审核员 / 超级管理员**双角色。

---

## 目录

- [1. 概述](#1-概述)
- [2. 通用约定](#2-通用约定)
- [3. 数据模型](#3-数据模型)
- [4. 接口详情](#4-接口详情)
- [5. 业务规则与副作用](#5-业务规则与副作用)
- [6. 安全规范](#6-安全规范)
- [7. 附录](#7-附录)

---

## 1. 概述

### 1.1 基本信息

| 项            | 约定                                       |
| ------------- | ------------------------------------------ |
| Base URL      | `/api`                                     |
| 传输协议      | 仅 HTTPS                                   |
| 请求/响应格式 | `application/json; charset=utf-8`          |
| 时间格式      | ISO 8601（UTC），如 `2026-10-11T06:00:00Z` |
| 日期字段格式  | `YYYY-MM-DD`，如 `2025-05-20`              |
| ID 类型       | 正整数，服务端自增分配                     |

### 1.2 角色与权限模型

| 角色         | 鉴权方式               | 能力                                       |
| ------------ | ---------------------- | ------------------------------------------ |
| 游客（任何人） | 无                     | 查看翻车列表、提交新增 / 修改建议（需 Turnstile） |
| 审核员       | `adminToken`（Bearer） | 阅读建议、通过 / 驳回                       |
| 超级管理员   | `adminToken`（Bearer） | 审核员全部能力 + 审核记录、审核员管理、条目直接管理 |

> 💡 没有注册体系。**超级管理员密码**来自环境变量 `ADMIN_PASSWORD`；**审核员账号**存于数据库 `reviewers` 表（PBKDF2 慢哈希）。
> 登录接口会先比对该密码是否等于超级管理员密码，否则依次比对每个审核员的密码哈希，命中即确定身份与角色。

### 1.3 核心业务流

**提交建议流程（所有条目变更都需审核）：**

```
游客填写表单 ──> 完成 Turnstile ──> POST /api/submissions {type, changes}
                                          │
                                          ▼
                                   进入 pending 队列
                                          │
                        ┌─── 审核员 approve ──> 变更应用到成员（或新建成员）
                        └─── 审核员 reject ───> 记录驳回理由
```

**管理流程：**

```
POST /admin/login ──> adminToken（role 自动识别）
      │
      ├── 审核员：GET /admin/submissions → approve / reject
      └── 超级管理员：+ /admin/audit、/admin/reviewers、/admin/members
```

---

## 2. 通用约定

### 2.1 统一响应包

所有接口（包括错误）都返回 JSON 包装结构，`ok` 字段为总开关：

```jsonc
// 成功
{ "ok": true, "data": <业务数据，类型见各接口> }
// 失败
{
  "ok": false,
  "error": { "code": "FIELD_INVALID", "message": "翻车日期格式应为 YYYY-MM-DD（如 2025-05-20）" }
}
```

> 📌 客户端判定逻辑：HTTP 状态非 2xx **或** `payload.ok !== true` 均视为失败，以 `error.code` / `error.message` 为准。HTTP 状态码与 `error.code` 需同时正确。

### 2.2 认证方式

后台接口（路径以 `/admin/` 开头，`/admin/login` 除外）必须携带：

```
Authorization: Bearer <adminToken>
```

> `GET /api/submissions`（无 `admin/` 前缀）是 `GET /api/admin/submissions` 的兼容别名，同样需要 Bearer。

### 2.3 令牌体系

|            | adminToken                                                                  |
| ---------- | --------------------------------------------------------------------------- |
| **签发方** | `POST /api/admin/login`                                                     |
| **传递方式** | `Authorization: Bearer` 头                                                 |
| **有效期** | 2 小时（响应中 `expiresAt` 一并返回）                                       |
| **使用次数** | 有效期内不限次                                                             |
| **失效表现** | `401 ADMIN_TOKEN_INVALID`（客户端收到后清除本地令牌并回到登录页）           |
| **吊销**   | 服务端 `admin_sessions` 表存储会话；删除审核员时同步吊销其全部会话；过期会话惰性清理 |

> 令牌为不透明随机字符串（`at_` + 32 位十六进制）。超级管理员与审核员使用同一套令牌，仅靠会话中的 `role` 区分权限。

### 2.4 HTTP 状态码

| 状态码 | 含义           | 本系统使用场景                       |
| ------ | -------------- | ------------------------------------ |
| 200    | 成功           | 所有成功响应                         |
| 400    | 客户端参数错误 | 校验失败（见错误码表）               |
| 401    | 认证失败       | 密码错误、令牌无效/过期              |
| 403    | 授权失败       | 审核员访问超级管理员专属接口         |
| 404    | 资源不存在     | 条目 / 审核记录 / 审核员不存在、未知路由 |
| 409    | 冲突           | 重复审核、审核员名称重复             |
| 413    | 请求体过大     | 请求体超过 64KB                      |
| 429    | 限流           | 触发频率限制                         |
| 500    | 服务端异常     | `INTERNAL_ERROR`                     |
| 502    | 上游异常       | Turnstile 校验服务不可用             |

### 2.5 错误码总表

| code                  | HTTP     | 触发场景                                                |
| --------------------- | -------- | ------------------------------------------------------- |
| `PARAM_MISSING`       | 400      | 请求体非法 / 缺 `type` / 缺 `memberId`                   |
| `FIELD_MISSING`       | 400      | 新增条目缺少必填字段（`username` / `name` / `crashDate`） |
| `FIELD_INVALID`       | 400      | 字段类型或格式不正确（用户名 / 日期 / 头像 / 标签 / 审核员密码…） |
| `FIELD_FORBIDDEN`     | 400      | 提交了白名单外字段（如 `id`）                            |
| `CHANGES_EMPTY`       | 400      | `changes` 为空对象或非法类型                             |
| `REASON_REQUIRED`     | 400      | 驳回时未填 `reason`                                      |
| `TURNSTILE_FAILED`    | 400 / 502 | 人机验证缺失 / 失败 / 服务不可用                         |
| `PASSWORD_WRONG`      | 401      | 管理密码错误                                             |
| `ADMIN_TOKEN_INVALID` | 401      | `adminToken` 缺失 / 无效 / 过期                          |
| `FORBIDDEN`           | 403      | 权限不足（审核员访问超级管理员接口）                     |
| `NOT_FOUND`           | 404      | 审核记录不存在 / 未知路由                                |
| `MEMBER_NOT_FOUND`    | 404      | 条目不存在（含 approve 时目标条目已被删除）              |
| `REVIEWER_NOT_FOUND`  | 404      | 审核员不存在                                             |
| `REVIEWER_EXISTS`     | 409      | 审核员名称已存在                                         |
| `ALREADY_REVIEWED`    | 409      | 审核记录已处理（终态）                                   |
| `RATE_LIMITED`        | 429      | 触发限流                                                 |
| `BODY_TOO_LARGE`      | 413      | 请求体超过 64KB                                          |
| `INTERNAL_ERROR`      | 500      | 服务端异常（兜底）                                       |

---

## 3. 数据模型

### 3.1 Member（翻车条目 · 对外对象）

所有返回条目的接口统一使用此结构：

```json
{
  "id": 1,
  "username": "misaka_mikoto",
  "name": "御坂美琴",
  "crashDate": "2025-05-20",
  "bio": "直播时把「超电磁炮」念成「超电磁炉」，当场被弹幕笑翻。",
  "avatar": "https://api.dicebear.com/7.x/thumbs/svg?seed=Misaka",
  "tags": ["直播翻车", "口播失误"]
}
```

### 3.2 字段定义与校验规则

| 字段        |    类型    |  新增必填  | 用户建议可改 | 管理端可改 | 约束                                                                 |
| ----------- | :--------: | :--------: | :----------: | :--------: | -------------------------------------------------------------------- |
| `id`        |   number   | 服务端生成 |      ✗       |     ✗      | 正整数，自增                                                         |
| `username`  |   string   |     ✓      |      ✓       |     ✓      | 规范化后须匹配 `^[a-z0-9_]{1,15}$`；**不唯一**（同一人可多条）       |
| `name`      |   string   |     ✓      |      ✓       |     ✓      | 非空，≤ 32 字符                                                      |
| `crashDate` |   string   |     ✓      |      ✓       |     ✓      | `YYYY-MM-DD` 且为合法日期（前台按月分组）                            |
| `bio`       |   string   |     ✗      |      ✓       |     ✓      | 翻车详情；出现即覆盖，可空串清空                                     |
| `avatar`    |   string   |     ✗      |      ✓       |     ✓      | URL；空 = 前端用昵称首字占位；仅允许 http/https，裸域名自动补 `https://` |
| `tags`      |  string[]  |     ✗      |      ✓       |     ✓      | 出现即整体替换；≤ 8 个，单个 ≤ 24 字符                               |

**校验实现细节（服务端为准）：**

- **用户名规范化**：去除 `@`、`https://` / `www.` 前缀、`x.com|twitter.com|mobile.twitter.com` 域名与路径及查询串，统一转小写；规范化结果须匹配 `^[a-z0-9_]{1,15}$`（X 官方用户名规则），否则 `FIELD_INVALID`。
- **翻车日期**：正则 `^\d{4}-\d{2}-\d{2}$` 且 `new Date(y,m-1,d)` 可往返（拒绝 `2025-02-30` 之类）。
- **头像 URL**：显式 `http(s)://` 合法；不含协议前缀的裸链接（如 `pbs.twimg.com/xxx.jpg`）自动补 `https://`；出现其他协议（如 `javascript:`、`data:`）一律 `FIELD_INVALID`。
- **标签**：必须为字符串数组；服务端 trim、去空、截断至最多 8 个（提交超过 8 个本身即 `FIELD_INVALID`）。
- **边界**：`bio` 目前**不设**硬性长度上限，但客户端应限制，服务端只做类型校验。

**部分更新语义（`PUT /admin/members/{id}`）：**

- 字段未出现在 JSON 中 = 不修改；出现即修改。
- `tags` 无「追加」语义，传则整体替换。
- 传空串可清空 `bio` / `avatar`；`username` / `name` / `crashDate` 出现则必须合法（值校验见上）。

### 3.3 Submission（审核记录）

```json
{
  "id": 12,
  "type": "update",
  "memberId": 1,
  "memberName": "御坂美琴",
  "memberUsername": "misaka_mikoto",
  "changes": { "crashDate": "2025-05-22", "bio": "补充新的细节" },
  "oldData": { "crashDate": "2025-05-20", "bio": "旧的详情" },
  "createdAt": "2026-10-11T06:00:00Z",
  "status": "pending",
  "reason": null,
  "reviewedAt": null,
  "reviewedBy": null
}
```

| 字段                          | 类型            | 说明                                                                    |
| ----------------------------- | --------------- | ----------------------------------------------------------------------- |
| `id`                          | number          | 提交记录 ID                                                             |
| `type`                        | string          | `create`（新增条目）/ `update`（修改条目）                              |
| `memberId`                    | number \| null  | 目标条目 ID；`create` 时为 `null`                                       |
| `memberName`                  | string          | 提交时刻的昵称快照（`create` 时即 `changes.name`）                      |
| `memberUsername`              | string          | 提交时刻的用户名快照（`create` 时即 `changes.username`）                |
| `changes`                     | object          | 变更字段集，仅含白名单字段                                              |
| `oldData`                     | object          | 提交时刻旧值快照，仅含 `changes` 中出现的字段，供审核界面展示 diff（`create` 为 `{}`） |
| `createdAt`                   | string          | 提交时间                                                                |
| `status`                      | string          | `pending` / `approved` / `rejected`                                     |
| `reason`                      | string \| null  | 驳回理由（仅 `rejected`）                                               |
| `reviewedAt`                  | string \| null  | 处理时间（仅终态）                                                      |
| `reviewedBy`                  | string \| null  | 处理人（审核员名 / 超级管理员）                                         |

> ⚠️ **字段白名单：** `username`、`name`、`crashDate`、`bio`、`avatar`、`tags`。其余任何字段（含 `id`、`memberId`）→ `400 FIELD_FORBIDDEN`。

### 3.4 Reviewer（审核员）

```json
{ "id": 1, "name": "审核员甲", "createdAt": "2026-10-11T06:00:00Z" }
```

> `password_hash` **绝不返回**，仅存 PBKDF2 慢哈希（格式 `pbkdf2$轮数$盐$摘要`）。

### 3.5 AuditLog（审核 / 审计记录）

```json
{
  "id": 30,
  "actor": "审核员甲",
  "actorRole": "reviewer",
  "action": "approve",
  "target": "修改 #12 御坂美琴",
  "detail": "{\"crashDate\":\"2025-05-22\"}",
  "createdAt": "2026-10-11T06:05:00Z"
}
```

`action` 取值：`login`、`approve`、`reject`、`add_reviewer`、`update_reviewer`、`delete_reviewer`、`create_member`、`update_member`、`delete_member`。

---

## 4. 接口详情

### 4.1 GET /api/config — 公开配置

前端启动时获取 Turnstile 开关与站点公钥。

- **权限：** 公开
- **请求参数：** 无

**成功 200：**

```json
{ "ok": true, "data": { "turnstileEnabled": true, "turnstileSiteKey": "0x4AAA..." } }
```

**说明：** `turnstileEnabled` = 服务端是否配置了 `TURNSTILE_SECRET_KEY`。为 `false` 时前端不渲染 Turnstile 控件、提交时不带 token。

---

### 4.2 GET /api/members — 翻车条目列表

获取全部已生效条目。前台时间线数据源。

- **权限：** 公开
- **请求参数：** 无

**成功 200：**

```json
{ "ok": true, "data": [{ "...Member 对象": "" }] }
```

**说明：**

- 服务端按 `crash_date DESC, id DESC` 排序；客户端也可再按 `crashDate` 所属月份分组展示。
- 空列表返回 `"data": []`（非 null）。
- **错误：** 仅通用 `500 INTERNAL_ERROR`。

---

### 4.3 POST /api/submissions — 提交新增 / 修改建议

任何人可提交，进入待审队列。**所有条目变更都必须经过审核。**

- **权限：** 公开（需 Turnstile，若服务端已配置；强制限流）

**请求 Body：**

| 字段             |   类型   | 必填 | 说明                                            |
| ---------------- | :------: | :--: | ----------------------------------------------- |
| `type`           |  string  |  ✓   | `create`（新增）或 `update`（修改）             |
| `memberId`       |  number  | 条件 | `type=update` 时必填；`create` 时忽略          |
| `changes`        |  object  |  ✓   | 变更字段集，仅含白名单字段                       |
| `turnstileToken` |  string  | 条件 | 服务端配置了 `TURNSTILE_SECRET_KEY` 时必填       |

```json
// 新增
{
  "type": "create",
  "changes": {
    "username": "@elonmusk",
    "name": "马斯克",
    "crashDate": "2025-05-20",
    "bio": "把 X 改成 Y 又改回来",
    "avatar": "pbs.twimg.com/xxx.jpg",
    "tags": ["口嗨", "打脸"]
  },
  "turnstileToken": "0.xxxx"
}
```

```json
// 修改
{
  "type": "update",
  "memberId": 3,
  "changes": { "crashDate": "2025-05-22", "bio": "补充新的细节" },
  "turnstileToken": "0.xxxx"
}
```

**成功 200：**

```json
{ "ok": true, "data": { "submissionId": 12 } }
```

**错误：**

| code                    | 条件                                             |
| ----------------------- | ------------------------------------------------ |
| `PARAM_MISSING`         | `type` 非 `create` / `update`，或 `update` 缺 `memberId` |
| `TURNSTILE_FAILED`      | 已配置校验但 token 缺失 / 失败 / 服务不可用      |
| `CHANGES_EMPTY`         | `changes` 为空对象或非法类型                     |
| `FIELD_MISSING`         | `create` 缺少 `username` / `name` / `crashDate`  |
| `FIELD_INVALID`         | 字段类型 / 格式不合法                            |
| `FIELD_FORBIDDEN`       | 含白名单外字段                                   |
| `MEMBER_NOT_FOUND`      | `update` 的目标条目不存在                        |
| `RATE_LIMITED`          | 限流                                             |

**说明：**

- 服务端处理顺序：限流 → 读取/解析 body → 校验 `type` → **Turnstile 校验** → 字段白名单与值校验 → 落库。
- `create` 时 `memberName` / `memberUsername` 取 `changes` 中的昵称 / 用户名；`update` 时记录目标条目的快照，并保存 `changes` 中字段的旧值快照。
- 用户名不唯一：同名 `username` 可存在多条不同 `crashDate` 的条目。

---

### 4.4 POST /api/admin/login — 后台登录（统一入口）

同一个入口自动识别**超级管理员**或**审核员**。

- **权限：** 公开（强制限流）

**请求 Body：**

```json
{ "password": "..." }
```

**成功 200：**

```json
{
  "ok": true,
  "data": {
    "adminToken": "at_x9y8z7...",
    "role": "super",
    "identity": "超级管理员",
    "expiresAt": "2026-10-11T08:00:00Z"
  }
}
```

| 字段         | 说明                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| `role`       | `super`（超级管理员）或 `reviewer`（审核员）                             |
| `identity`   | 显示名：超级管理员恒为 `"超级管理员"`；审核员为其 `name`                 |
| `expiresAt`  | 会话到期时间，签发后 2 小时                                              |

**错误：** `401 PASSWORD_WRONG` / `429 RATE_LIMITED`

**说明：**

- 先与 `env.ADMIN_PASSWORD` 恒时比较；不匹配再遍历 `reviewers` 表逐一做 PBKDF2 校验。
- `ADMIN_PASSWORD` 未配置时无法以超级管理员身份登录（仍可用审核员密码登录）。
- 登录成功写入 `audit_logs`（`action=login`）。

---

### 4.5 GET /api/admin/me — 当前会话

- **权限：** 审核员 +

**成功 200：**

```json
{ "ok": true, "data": { "role": "reviewer", "identity": "审核员甲" } }
```

**错误：** `401 ADMIN_TOKEN_INVALID`

---

### 4.6 GET /api/admin/submissions — 审核记录列表

- **权限：** 审核员 +

**Query 参数：**

| 参数     | 可选值                                | 默认      | 说明       |
| -------- | ------------------------------------- | --------- | ---------- |
| `status` | `pending` / `approved` / `rejected`   | `pending` | 按状态筛选 |

**成功 200：**

```json
{ "ok": true, "data": [{ "...Submission 对象": "" }] }
```

**说明：**

- 排序：`created_at DESC, id DESC`（最新在前）。
- **非法 `status` 返回 `"data": []`（200），不报错。**
- 别名：`GET /api/submissions?status=` 行为完全一致（需 Bearer）。
- **错误：** `401 ADMIN_TOKEN_INVALID`

---

### 4.7 POST /api/admin/submissions/{id}/approve — 通过审核

- **权限：** 审核员 +
- **Body：** 无

**成功 200：**

```json
{ "ok": true, "data": { "applied": true } }
```

**副作用（同一 `batch` 事务）：**

- `type=create`：在 `members` 插入新条目（用 `changes` 规范化后的值）。
- `type=update`：将 `changes` 应用到 `member_id` 指向的条目（last-write-wins，不做冲突检测）。
- 审核记录 `status → approved`，写入 `reviewed_at`、`reviewed_by`。
- 写 `audit_logs`（`action=approve`）。

**错误：**

| code                 | 条件                                       |
| -------------------- | ------------------------------------------ |
| `ADMIN_TOKEN_INVALID`| 未认证                                     |
| `NOT_FOUND`          | 审核记录不存在                             |
| `ALREADY_REVIEWED`   | 已处理（终态）                             |
| `MEMBER_NOT_FOUND`   | `update` 的目标条目已被删除，拒绝应用变更  |

---

### 4.8 POST /api/admin/submissions/{id}/reject — 驳回

- **权限：** 审核员 +

**请求 Body：**

| 字段     |  类型  | 必填 | 说明           |
| -------- | :----: | :--: | -------------- |
| `reason` | string |  ✓   | 驳回理由，非空 |

```json
{ "reason": "详情内容不合适，请修改后重新提交" }
```

**成功 200：**

```json
{ "ok": true, "data": { "applied": false } }
```

**副作用：** `status → rejected`，记录 `reason`、`reviewed_at`、`reviewed_by`，并写 `audit_logs`（`action=reject`）。**不触碰条目数据。**

**错误：** `401 ADMIN_TOKEN_INVALID` / `400 REASON_REQUIRED` / `404 NOT_FOUND` / `409 ALREADY_REVIEWED`

> 处理顺序：先校验 `reason`（缺失直接 `REASON_REQUIRED`），再检查记录是否存在与是否已处理。

---

### 4.9 GET /api/admin/audit — 审核 / 审计记录

- **权限：** **超级管理员**
- **Query 参数：**

| 参数    | 类型   | 默认 | 说明                          |
| ------- | ------ | ---- | ----------------------------- |
| `limit` | number | 100  | 返回条数；非法或 ≤0 时取 100；上限 **500** |

**成功 200：**

```json
{ "ok": true, "data": [{ "...AuditLog 对象": "" }] }
```

**说明：** 按 `id DESC`（最新在前）。**错误：** `401 ADMIN_TOKEN_INVALID` / `403 FORBIDDEN`

---

### 4.10 GET /api/admin/reviewers — 审核员列表

- **权限：** **超级管理员**

**成功 200：**

```json
{ "ok": true, "data": [{ "id": 1, "name": "审核员甲", "createdAt": "2026-10-11T06:00:00Z" }] }
```

**错误：** `401 ADMIN_TOKEN_INVALID` / `403 FORBIDDEN`

---

### 4.11 POST /api/admin/reviewers — 新增审核员

- **权限：** **超级管理员**

**请求 Body：**

| 字段       |  类型  | 必填 | 说明               |
| ---------- | :----: | :--: | ------------------ |
| `name`     | string |  ✓   | 审核员显示名，≤ 32 字符，唯一 |
| `password` | string |  ✓   | 登录密码，≥ 6 位   |

```json
{ "name": "审核员甲", "password": "reviewer1" }
```

**成功 200：**

```json
{ "ok": true, "data": { "id": 1 } }
```

**错误：** `400 FIELD_MISSING`（缺名称）/ `400 FIELD_INVALID`（名称超长、密码 < 6 位）/ `409 REVIEWER_EXISTS` / `401` / `403`

---

### 4.12 PUT /api/admin/reviewers/{id} — 修改审核员

- **权限：** **超级管理员**
- **语义：** 部分更新；`name`、`password` 均可选，出现即修改（二者都不传 = 无操作，仍返回成功并记审计）。

```json
{ "name": "新的名字", "password": "newpass123" }
```

**成功 200：**

```json
{ "ok": true, "data": { "updated": true } }
```

**错误：** `404 REVIEWER_NOT_FOUND` / `400 FIELD_INVALID`（名称为空/超长、密码 < 6 位）/ `409 REVIEWER_EXISTS`（名称与他人重复）/ `401` / `403`

---

### 4.13 DELETE /api/admin/reviewers/{id} — 删除审核员

- **权限：** **超级管理员**
- **Body：** 无

**成功 200：**

```json
{ "ok": true, "data": { "deleted": true } }
```

**级联副作用（同一 `batch` 事务）：** 删除审核员记录，并**吊销其全部会话**（`admin_sessions` 中 `role='reviewer' AND identity=name`）。被删除者持有的旧 token 立即失效。

**错误：** `404 REVIEWER_NOT_FOUND` / `401` / `403`

---

### 4.14 GET /api/admin/members — 条目列表（管理端）

- **权限：** **超级管理员**
- **说明：** 与 `GET /api/members` 返回一致（管理端也**不**额外暴露任何隐藏字段）。
- **错误：** `401` / `403`

---

### 4.15 POST /api/admin/members — 新增条目（立即生效）

- **权限：** **超级管理员**
- **生效方式：** 立即生效，**不进入审核流**

**请求 Body：** 与提交白名单一致；`username` / `name` / `crashDate` 必填。

```json
{
  "username": "elonmusk",
  "name": "马斯克",
  "crashDate": "2025-05-20",
  "bio": "……",
  "avatar": "",
  "tags": ["口嗨"]
}
```

**成功 200：**

```json
{ "ok": true, "data": { "id": 13 } }
```

**错误：** `400 FIELD_MISSING` / `400 FIELD_INVALID` / `400 FIELD_FORBIDDEN` / `400 CHANGES_EMPTY` / `401` / `403`

---

### 4.16 PUT /api/admin/members/{id} — 修改条目（立即生效）

- **权限：** **超级管理员**
- **语义：** 部分更新，字段缺省 = 不修改（见 §3.2）。

```json
{ "crashDate": "2025-05-22", "bio": "新的详情", "tags": ["口嗨", "打脸"] }
```

**成功 200：**

```json
{ "ok": true, "data": { "updated": true } }
```

**错误：** `400 FIELD_INVALID` / `400 FIELD_FORBIDDEN` / `400 CHANGES_EMPTY`（空对象）/ `404 MEMBER_NOT_FOUND` / `401` / `403`

---

### 4.17 DELETE /api/admin/members/{id} — 删除条目

- **权限：** **超级管理员**
- **Body：** 无

**成功 200：**

```json
{ "ok": true, "data": { "deleted": true } }
```

**级联副作用（同一 `batch` 事务）：**

1. 删除条目记录；
2. 该条目所有 `pending` 建议自动作废：`status → rejected`、`reason = "目标条目已被删除，提交自动作废"`、记录 `reviewed_at`、`reviewed_by`。

**错误：** `404 MEMBER_NOT_FOUND` / `401` / `403`

> ⚠️ 非幂等：重复删除同一 id 返回 404（前端已做两步确认与按钮禁用防重）。

---

## 5. 业务规则与副作用

### 5.1 审核状态机

```
                ┌── approve（审核员/超管）─────> approved（终态，变更已应用）
  pending ──────┤
                ├── reject（审核员/超管，必填理由）─> rejected（终态）
                └── 目标条目被删除（自动）──────> rejected（理由固定）
```

- `approved` / `rejected` 为终态，再次操作返回 `409 ALREADY_REVIEWED`。
- 无撤回、无重新打开操作。

### 5.2 并发与一致性规则

| 场景                                     | 行为                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 同一目标条目存在多个 pending 提交        | 允许；按审核先后逐个应用，后审覆盖先审（last-write-wins）                                                   |
| 提交后、审核前，超管已直接编辑该条目     | approve 时 `changes` 仍全量应用（覆盖中间修改）；`oldData` 是提交时刻快照，可能与审核时刻的当前值不一致     |
| approve 时目标条目已被删除               | 拒绝应用，返回 `404 MEMBER_NOT_FOUND`                                                                       |
| 删除条目与审核并发                       | 删除事务级联作废 pending；已终态记录不受影响                                                                |
| 审核员被删除后使用旧 token               | 会话已在删除事务中吊销，返回 `401 ADMIN_TOKEN_INVALID`                                                      |

### 5.3 数据可见性汇总

| 数据                        | 游客 | 审核员 | 超级管理员 |
| --------------------------- | :--: | :----: | :--------: |
| 条目公开字段                |  ✓   |   ✓    |     ✓      |
| 待审 / 已审记录             |  ✗   |   ✓    |     ✓      |
| 驳回理由                    |  ✗   |   ✓    |     ✓      |
| 审核员密码哈希              |  ✗   |   ✗    |  ✗（任何接口不返回） |
| 审计日志                    |  ✗   |   ✗    |     ✓      |

---

## 6. 安全规范

### 6.1 密码与令牌

| 项            | 方案                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| 超级管理员密码 | 环境变量 `ADMIN_PASSWORD`，登录时恒时比较（`timingSafeEqual`），**不存库**                 |
| 审核员密码     | PBKDF2-SHA256，10 万轮 + 16 字节随机盐，格式 `pbkdf2$轮数$盐$摘要`，存储于 `reviewers` 表 |
| adminToken    | 32 字节随机十六进制（`at_` 前缀），会话落 `admin_sessions` 表，可主动吊销，2 小时过期       |

### 6.2 Cloudflare Turnstile

- `POST /api/submissions` 在服务端配置了 `TURNSTILE_SECRET_KEY` 时**强制**校验 `turnstileToken`。
- 校验请求发往 `https://challenges.cloudflare.com/turnstile/v0/siteverify`，并携带客户端 IP（`CF-Connecting-IP`）。
- 未配置 `TURNSTILE_SECRET_KEY` 时**完全跳过**校验（便于本地开发）；`GET /api/config` 会告知前端 `turnstileEnabled=false`。
- `TURNSTILE_SITE_KEY` 通过 `GET /api/config` 下发给前端渲染控件。

### 6.3 限流策略

| 接口                                   | 限制              | 计数键              |
| -------------------------------------- | ----------------- | ------------------- |
| `POST /api/admin/login`                | 5 次/分钟/IP      | `admin-login`       |
| `POST /api/submissions`                | 10 次/小时/IP     | `submissions`       |

超限统一返回 `429 RATE_LIMITED`。限流基于 D1 `rate_limits` 计数窗口，写入前先清理窗口外过期记录。

### 6.4 请求校验

| 项         | 要求                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------- |
| 传输       | 全站 HTTPS（建议 + HSTS）                                                                |
| 请求体     | 上限 64KB，超限 `413 BODY_TOO_LARGE`；必须为 JSON 对象（数组 / 基本类型 → `PARAM_MISSING`） |
| 服务端校验 | 所有输入独立校验（前端校验仅为体验）：类型、长度上限、URL 协议白名单（http/https）       |
| 越权防护   | `/admin/audit`、`/admin/reviewers`、`/admin/members` 仅超级管理员；审核员 → `403 FORBIDDEN` |
| CORS       | 按部署域名白名单配置                                                                     |

---

## 7. 附录

### 7.1 接口速查表

|  #  | 方法   | 路径                                      | 权限          | 说明                          |
| :-: | ------ | ----------------------------------------- | ------------- | ----------------------------- |
|  1  | GET    | `/api/config`                             | 公开          | Turnstile 开关与站点公钥      |
|  2  | GET    | `/api/members`                            | 公开          | 翻车条目列表（前台数据源）    |
|  3  | POST   | `/api/submissions`                        | 公开 + 限流   | 提交新增 / 修改建议           |
|  4  | GET    | `/api/submissions?status=`                | 审核员 +      | 审核记录列表（别名）          |
|  5  | POST   | `/api/admin/login`                        | 公开 + 限流   | 统一后台登录                  |
|  6  | GET    | `/api/admin/me`                           | 审核员 +      | 当前会话 `{ role, identity }` |
|  7  | GET    | `/api/admin/submissions?status=`          | 审核员 +      | 审核记录列表                  |
|  8  | POST   | `/api/admin/submissions/{id}/approve`     | 审核员 +      | 通过（应用变更）              |
|  9  | POST   | `/api/admin/submissions/{id}/reject`      | 审核员 +      | 驳回（必填理由）              |
| 10  | GET    | `/api/admin/audit?limit=`                 | 超级管理员    | 审计记录（最新在前，≤ 500）   |
| 11  | GET    | `/api/admin/reviewers`                    | 超级管理员    | 审核员列表                    |
| 12  | POST   | `/api/admin/reviewers`                    | 超级管理员    | 新增审核员                    |
| 13  | PUT    | `/api/admin/reviewers/{id}`               | 超级管理员    | 修改审核员名称 / 密码         |
| 14  | DELETE | `/api/admin/reviewers/{id}`               | 超级管理员    | 删除审核员并吊销其会话        |
| 15  | GET    | `/api/admin/members`                      | 超级管理员    | 条目列表（管理端）            |
| 16  | POST   | `/api/admin/members`                      | 超级管理员    | 新增条目（立即生效）          |
| 17  | PUT    | `/api/admin/members/{id}`                 | 超级管理员    | 修改条目（立即生效）          |
| 18  | DELETE | `/api/admin/members/{id}`                 | 超级管理员    | 删除条目（级联作废 pending）  |

### 7.2 客户端行为约定（后端需知悉）

- 收到 `401 ADMIN_TOKEN_INVALID` → 客户端清除令牌、回到后台登录页。
- 所有错误原样展示 `error.message`（因此 message 需用户友好）。
- 任何管理端条目变更后，客户端会在下次进入前台时重新拉取 `/api/members`。
- `GET /api/config` 在应用初始化时调用一次，决定是否挂载 Turnstile 控件。

### 7.3 Mock 演示环境

前端内置 Mock 后端（`content/index.html` 中 `const USE_MOCK = true`），无需真实后端即可演示全流程，接口行为与本文档一致：

- **超级管理员密码：** `admin888`
- **内置审核员：** `审核员甲 / reviewer1`、`审核员乙 / reviewer2`
- 内置 8 条示例条目；提交建议、审核、审核员管理、条目管理全部可用（数据存在内存，刷新即重置）。

**接入真实后端：** 将 `USE_MOCK` 改为 `false` 后重新部署即可，前端零改动。

### 7.4 版本演进建议（本期不实现）

- [ ] 列表分页：`?page=&pageSize=` → `data: { list, total }`
- [ ] 按 `username` 查询某人的全部翻车记录
- [ ] 审核记录与条目版本号乐观锁（替代 last-write-wins）
- [ ] `turnstileToken` 与提交内容的绑定校验（action / hostname 校验）
- [ ] 审计日志持久化保留策略与导出

---

> 📄 文档结束。任何接口行为与本文档冲突时，以本文档为准；如需变更，须同步更新 `src/index.js`、前端 `apiFetch` 调用侧与错误码处理逻辑。
