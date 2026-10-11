/**
 * X友跨翻车列表 · 后端实现
 * Cloudflare Workers + D1。所有响应统一为 { ok, data|error }。
 *
 * 角色模型：
 *   - 游客（任何人）：查看列表；提交「新增条目 / 修改条目」建议（需 Cloudflare Turnstile）
 *   - 审核员：密码登录，阅读建议并审核（通过 / 驳回）
 *   - 超级管理员：额外可查看审核记录、管理审核员列表、直接管理条目
 */

/* =============== 常量 =============== */
const WHITELIST_FIELDS = ["username", "name", "crashDate", "bio", "avatar", "tags"];
const CORE_FIELDS = ["username", "name", "crashDate"]; // 新增条目时必填
const FIELD_LABELS = { username: "用户名", name: "昵称", crashDate: "翻车日期" };
const SESSION_TTL_MS = 2 * 3600 * 1000; // 管理会话 2 小时
const MAX_BODY_BYTES = 64 * 1024; // 请求体上限 64KB
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ENCODER = new TextEncoder();

/* =============== 统一响应包 =============== */
class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
const OK = (data) => jsonRes({ ok: true, data }, 200);
const ERR = (code, message, status) =>
  jsonRes({ ok: false, error: { code, message } }, status);
const nowISO = () => new Date().toISOString();

/* =============== 密码学工具 =============== */

/** 慢哈希（审核员密码）：PBKDF2-SHA256。格式：pbkdf2$轮数$盐$摘要 */
async function pbkdf2Hash(secret, iterations = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(secret, salt, iterations);
  return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(bits)}`;
}
async function pbkdf2Verify(secret, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterStr, saltHex, expected] = parts;
  let salt;
  try {
    salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  } catch {
    return false;
  }
  const iter = parseInt(iterStr, 10) || 100000;
  const bits = await deriveBits(secret, salt, iter);
  return timingSafeEqual(toHex(bits), expected); // 恒时比较
}
async function deriveBits(str, saltBuf, iterations) {
  const km = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(str),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBuf, iterations, hash: "SHA-256" },
    km,
    256,
  );
}
function toHex(buf) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return prefix + toHex(bytes);
}

/* =============== 校验工具 =============== */

function isHttpUrl(u) {
  try {
    return /^https?:$/i.test(new URL(u).protocol);
  } catch {
    return false;
  }
}
/** 服务端 URL 规范化：补全无协议前缀的链接为 https:// */
function normUrl(u) {
  const t = String(u || "").trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return "https:" + t;
  return "https://" + t;
}
/** 链接合法性：显式 http/https，或可规范化补 https 的裸域名；其他协议非法 */
function validUrlField(u) {
  if (!u) return true;
  return isHttpUrl(u) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(u).trim());
}

/** 规范化 X 用户名：去除 @、URL 前缀、路径与查询，统一小写 */
function normalizeUsername(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const m = s.match(/^(?:x\.com|twitter\.com|mobile\.twitter\.com)\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@+/, "").replace(/[/?#].*$/, "");
  return s.toLowerCase();
}
function isValidUsername(u) {
  return /^[a-z0-9_]{1,15}$/.test(u);
}
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function normalizeTags(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** 字段值校验（提交与直接管理共用）；违规抛 ApiError。不负责必填检查。 */
function validateFieldValues(o) {
  if ("username" in o) {
    if (typeof o.username !== "string")
      throw new ApiError("FIELD_INVALID", "用户名格式不正确", 400);
    const u = normalizeUsername(o.username);
    if (!u || !isValidUsername(u))
      throw new ApiError(
        "FIELD_INVALID",
        "用户名格式不正确（1-15 位字母、数字或下划线，可含 @）",
        400,
      );
  }
  if ("name" in o) {
    if (typeof o.name !== "string" || o.name.trim() === "")
      throw new ApiError("FIELD_INVALID", "昵称不能为空", 400);
    if (o.name.trim().length > 32)
      throw new ApiError("FIELD_INVALID", "昵称不能超过 32 个字符", 400);
  }
  if ("crashDate" in o) {
    if (typeof o.crashDate !== "string" || !isValidDate(o.crashDate.trim()))
      throw new ApiError(
        "FIELD_INVALID",
        "翻车日期格式应为 YYYY-MM-DD（如 2025-05-20）",
        400,
      );
  }
  for (const k of ["bio", "avatar"]) {
    if (k in o && typeof o[k] !== "string")
      throw new ApiError("FIELD_INVALID", `"${k}" 字段格式不正确`, 400);
  }
  if (o.avatar && !validUrlField(o.avatar))
    throw new ApiError("FIELD_INVALID", "头像链接格式不正确", 400);
  if ("tags" in o) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string"))
      throw new ApiError("FIELD_INVALID", "标签格式不正确", 400);
    if (o.tags.length > 8)
      throw new ApiError("FIELD_INVALID", "标签最多 8 个", 400);
    if (o.tags.some((t) => t.trim().length > 24))
      throw new ApiError("FIELD_INVALID", "单个标签不能超过 24 个字符", 400);
  }
}

/** 白名单 + 必填 + 类型校验（changes / member 直接管理共用） */
function assertAllowedAndValid(obj, requireCore) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    throw new ApiError("CHANGES_EMPTY", "提交内容格式不正确", 400);
  const keys = Object.keys(obj);
  if (keys.length === 0) throw new ApiError("CHANGES_EMPTY", "没有检测到修改内容", 400);
  for (const k of keys) {
    if (!WHITELIST_FIELDS.includes(k))
      throw new ApiError("FIELD_FORBIDDEN", `字段 "${k}" 不允许提交`, 400);
  }
  if (requireCore) {
    for (const f of CORE_FIELDS) {
      if (!(f in obj) || String(obj[f] ?? "").trim() === "")
        throw new ApiError(
          "FIELD_MISSING",
          `缺少必填字段 ${FIELD_LABELS[f] || f}`,
          400,
        );
    }
  }
  validateFieldValues(obj);
}

/** 提交内容校验：create 需含核心字段；update 应为字段子集 */
function validateChanges(type, changes) {
  assertAllowedAndValid(changes, type === "create");
}

/** 规范化后的存储对象（只保留白名单内出现过的字段） */
function sanitizeChanges(changes) {
  const out = {};
  if ("username" in changes) out.username = normalizeUsername(changes.username);
  if ("name" in changes) out.name = String(changes.name).trim();
  if ("crashDate" in changes) out.crashDate = String(changes.crashDate).trim();
  if ("bio" in changes) out.bio = String(changes.bio);
  if ("avatar" in changes) out.avatar = normUrl(changes.avatar);
  if ("tags" in changes) out.tags = normalizeTags(changes.tags);
  return out;
}

/* =============== 行 <-> 对象序列化 =============== */
function memberRowToObj(r) {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    crashDate: r.crash_date,
    bio: r.bio || "",
    avatar: r.avatar || "",
    tags: JSON.parse(r.tags || "[]"),
  };
}
function submissionRowToObj(r) {
  return {
    id: r.id,
    type: r.type,
    memberId: r.member_id ?? null,
    memberName: r.member_name || "",
    memberUsername: r.member_username || "",
    changes: JSON.parse(r.changes || "{}"),
    oldData: JSON.parse(r.old_data || "{}"),
    createdAt: r.created_at,
    status: r.status,
    reason: r.reason ?? null,
    reviewedAt: r.reviewed_at ?? null,
    reviewedBy: r.reviewed_by ?? null,
  };
}

/* =============== 基础设施 =============== */

async function readJson(request) {
  let text = "";
  try {
    text = await request.text();
  } catch {
    throw new ApiError("PARAM_MISSING", "无法读取请求体", 400);
  }
  if (ENCODER.encode(text).length > MAX_BODY_BYTES)
    throw new ApiError("BODY_TOO_LARGE", "请求体超过 64KB 上限", 413);
  if (!text.trim()) return {};
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new ApiError("PARAM_MISSING", "请求体不是合法 JSON", 400);
  }
  if (typeof j !== "object" || j === null || Array.isArray(j))
    throw new ApiError("PARAM_MISSING", "请求体应为 JSON 对象", 400);
  return j;
}

async function assertRateLimit(env, ip, endpoint, max, windowMs) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM rate_limits WHERE endpoint=? AND ts<?")
    .bind(endpoint, now - windowMs)
    .run();
  const c = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM rate_limits WHERE ip=? AND endpoint=? AND ts>=?",
  )
    .bind(ip, endpoint, now - windowMs)
    .first();
  if (c.c >= max)
    throw new ApiError("RATE_LIMITED", "操作过于频繁，请稍后再试", 429);
  await env.DB.prepare("INSERT INTO rate_limits(ip,endpoint,ts) VALUES(?,?,?)")
    .bind(ip, endpoint, now)
    .run();
}

/** 惰性清理过期会话 */
async function cleanExpired(env) {
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at<=?")
    .bind(Date.now())
    .run();
}

/** 管理鉴权：Bearer adminToken，查会话表，返回 { token, role, identity } */
async function requireAdmin(env, request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const token = m ? m[1].trim() : "";
  if (!token)
    throw new ApiError("ADMIN_TOKEN_INVALID", "未登录或登录已失效，请重新登录", 401);
  await cleanExpired(env);
  const row = await env.DB.prepare(
    "SELECT token, role, identity FROM admin_sessions WHERE token=? AND expires_at>?",
  )
    .bind(token, Date.now())
    .first();
  if (!row)
    throw new ApiError("ADMIN_TOKEN_INVALID", "未登录或登录已失效，请重新登录", 401);
  return row;
}
function assertSuper(session) {
  if (!session || session.role !== "super")
    throw new ApiError("FORBIDDEN", "该操作仅超级管理员可用", 403);
}

/** 写入审核 / 审计记录 */
async function audit(env, actor, role, action, target, detail) {
  await env.DB.prepare(
    "INSERT INTO audit_logs(actor,actor_role,action,target,detail,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(actor || "", role || "", action, target || "", detail || "", nowISO())
    .run();
}

/** Cloudflare Turnstile 校验；未配置 TURNSTILE_SECRET_KEY 时跳过（本地开发） */
async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return;
  const t = typeof token === "string" ? token.trim() : "";
  if (!t)
    throw new ApiError("TURNSTILE_FAILED", "请先完成人机验证", 400);
  const form = new URLSearchParams({ secret, response: t });
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  let data;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    data = await res.json();
  } catch {
    throw new ApiError("TURNSTILE_FAILED", "人机验证服务暂不可用，请稍后重试", 502);
  }
  if (!data || data.success !== true)
    throw new ApiError("TURNSTILE_FAILED", "人机验证失败，请重试", 400);
}

/* =============== 公开接口 =============== */

/** GET /api/config —— 前端获取 Turnstile site key */
async function getConfig(env) {
  const enabled = !!env.TURNSTILE_SECRET_KEY;
  return OK({
    turnstileEnabled: enabled,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
  });
}

/** GET /api/members */
async function listMembers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,username,name,crash_date,bio,avatar,tags FROM members ORDER BY crash_date DESC, id DESC",
  ).all();
  return OK(results.map(memberRowToObj));
}

/** POST /api/submissions —— 任何人提交新增 / 修改建议（需 Turnstile） */
async function createSubmission(env, request, ip) {
  await assertRateLimit(env, ip, "submissions", 10, 3600_000); // 10 次/小时/IP
  const body = await readJson(request);
  const type = body.type === "create" ? "create" : body.type === "update" ? "update" : null;
  if (!type)
    throw new ApiError("PARAM_MISSING", "type 必须为 create 或 update", 400);

  await verifyTurnstile(env, body.turnstileToken, ip);
  validateChanges(type, body.changes); // 校验失败不进入后续流程
  const changes = sanitizeChanges(body.changes);

  let memberId = null;
  let memberName = "";
  let memberUsername = "";
  let oldData = {};

  if (type === "create") {
    memberName = changes.name;
    memberUsername = changes.username;
  } else {
    const id = Number(body.memberId);
    if (!id) throw new ApiError("PARAM_MISSING", "缺少 memberId", 400);
    const mrow = await env.DB.prepare(
      "SELECT id,username,name,crash_date,bio,avatar,tags FROM members WHERE id=?",
    )
      .bind(id)
      .first();
    if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "目标条目不存在", 404);
    const cur = memberRowToObj(mrow);
    memberId = cur.id;
    memberName = cur.name;
    memberUsername = cur.username;
    for (const k of Object.keys(changes)) oldData[k] = cur[k]; // 提交时刻快照
  }

  const r = await env.DB.prepare(
    `INSERT INTO submissions
       (type, member_id, member_name, member_username, changes, old_data, created_at, status)
     VALUES (?,?,?,?,?,?,?, 'pending')`,
  )
    .bind(
      type,
      memberId,
      memberName,
      memberUsername,
      JSON.stringify(changes),
      JSON.stringify(oldData),
      nowISO(),
    )
    .run();
  return OK({ submissionId: r.meta.last_row_id });
}

/* =============== 管理接口 =============== */

/** POST /api/admin/login —— 统一密码登录，自动识别超级管理员 / 审核员 */
async function adminLogin(env, request, ip) {
  await assertRateLimit(env, ip, "admin-login", 5, 60_000);
  const body = await readJson(request);
  await verifyTurnstile(env, body.turnstileToken, ip);
  const pw = typeof body.password === "string" ? body.password : "";
  if (!pw) throw new ApiError("PASSWORD_WRONG", "密码错误", 401);

  let role = null;
  let identity = null;

  const superPw = env.ADMIN_PASSWORD || "";
  if (superPw && timingSafeEqual(pw, superPw)) {
    role = "super";
    identity = "超级管理员";
  } else {
    const { results } = await env.DB.prepare(
      "SELECT name,password_hash FROM reviewers ORDER BY id",
    ).all();
    for (const r of results) {
      if (await pbkdf2Verify(pw, r.password_hash)) {
        role = "reviewer";
        identity = r.name;
        break;
      }
    }
  }
  if (!role) throw new ApiError("PASSWORD_WRONG", "密码错误", 401);

  const token = randomToken("at_");
  await env.DB.prepare(
    "INSERT INTO admin_sessions(token,role,identity,expires_at) VALUES(?,?,?,?)",
  )
    .bind(token, role, identity, Date.now() + SESSION_TTL_MS)
    .run();
  await audit(env, identity, role, "login", "", "");
  return OK({
    adminToken: token,
    role,
    identity,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
}

/** GET /api/admin/submissions */
async function listSubmissions(env, url) {
  const status = url.searchParams.get("status") || "pending";
  const ALLOWED = ["pending", "approved", "rejected"];
  if (!ALLOWED.includes(status)) return OK([]);
  const { results } = await env.DB.prepare(
    `SELECT id,type,member_id,member_name,member_username,changes,old_data,created_at,status,reason,reviewed_at,reviewed_by
       FROM submissions WHERE status=? ORDER BY created_at DESC, id DESC`,
  )
    .bind(status)
    .all();
  return OK(results.map(submissionRowToObj));
}

async function getSubmission(env, id) {
  const r = await env.DB.prepare("SELECT * FROM submissions WHERE id=?")
    .bind(id)
    .first();
  if (!r) throw new ApiError("NOT_FOUND", "审核记录不存在", 404);
  return r;
}

/** 由规范化对象生成 members 的 SET 片段 */
function memberPairs(obj) {
  const cols = [];
  const args = [];
  for (const k of WHITELIST_FIELDS) {
    if (!(k in obj)) continue;
    if (k === "tags") {
      cols.push("tags=?");
      args.push(JSON.stringify(obj.tags));
    } else if (k === "crashDate") {
      cols.push("crash_date=?");
      args.push(obj.crashDate);
    } else {
      cols.push(`${k}=?`);
      args.push(obj[k]);
    }
  }
  return { cols, args };
}

function insertMemberStmt(env, obj) {
  return env.DB.prepare(
    `INSERT INTO members (username,name,crash_date,bio,avatar,tags,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(
    obj.username,
    obj.name,
    obj.crashDate,
    obj.bio ?? "",
    obj.avatar ?? "",
    JSON.stringify(obj.tags ?? []),
    nowISO(),
  );
}

/** POST /api/admin/submissions/{id}/approve */
async function approveSubmission(env, id, session) {
  const srow = await getSubmission(env, id);
  if (srow.status !== "pending")
    throw new ApiError("ALREADY_REVIEWED", "该审核记录已处理", 409);

  const raw = JSON.parse(srow.changes || "{}");
  const changes = sanitizeChanges(raw);
  const reviewedAt = nowISO();

  const stmts = [];
  if (srow.type === "create") {
    stmts.push(insertMemberStmt(env, changes));
  } else {
    const mrow = await env.DB.prepare("SELECT id FROM members WHERE id=?")
      .bind(srow.member_id)
      .first();
    if (!mrow)
      throw new ApiError("MEMBER_NOT_FOUND", "目标条目已被删除，拒绝应用变更", 404);
    const { cols, args } = memberPairs(changes);
    if (cols.length)
      stmts.push(
        env.DB.prepare(`UPDATE members SET ${cols.join(",")} WHERE id=?`).bind(
          ...args,
          srow.member_id,
        ),
      );
  }
  stmts.push(
    env.DB.prepare(
      "UPDATE submissions SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?",
    ).bind(reviewedAt, session.identity, id),
  );
  await env.DB.batch(stmts);

  await audit(
    env,
    session.identity,
    session.role,
    "approve",
    `${srow.type === "create" ? "新增" : "修改"} #${id} ${changes.name || srow.member_name}`,
    JSON.stringify(changes),
  );
  return OK({ applied: true });
}

/** POST /api/admin/submissions/{id}/reject */
async function rejectSubmission(env, request, id, session) {
  const body = await readJson(request);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason)
    throw new ApiError("REASON_REQUIRED", "驳回时必须填写驳回理由", 400);

  const srow = await getSubmission(env, id);
  if (srow.status !== "pending")
    throw new ApiError("ALREADY_REVIEWED", "该审核记录已处理", 409);

  await env.DB.prepare(
    "UPDATE submissions SET status='rejected', reason=?, reviewed_at=?, reviewed_by=? WHERE id=?",
  )
    .bind(reason, nowISO(), session.identity, id)
    .run();
  await audit(
    env,
    session.identity,
    session.role,
    "reject",
    `${srow.type === "create" ? "新增" : "修改"} #${id} ${srow.member_name}`,
    reason,
  );
  return OK({ applied: false });
}

/* ---------- 超级管理员：审核员管理 ---------- */

async function listReviewers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id,name,created_at FROM reviewers ORDER BY id",
  ).all();
  return OK(results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at })));
}

async function createReviewer(env, request, session) {
  const body = await readJson(request);
  const name = String(body.name ?? "").trim();
  const password = typeof body.password === "string" ? body.password : "";
  if (!name) throw new ApiError("FIELD_MISSING", "缺少审核员名称", 400);
  if (name.length > 32)
    throw new ApiError("FIELD_INVALID", "审核员名称不能超过 32 个字符", 400);
  if (password.length < 6)
    throw new ApiError("FIELD_INVALID", "密码至少 6 位", 400);
  const exists = await env.DB.prepare("SELECT id FROM reviewers WHERE name=?")
    .bind(name)
    .first();
  if (exists) throw new ApiError("REVIEWER_EXISTS", "该名称已存在", 409);

  const r = await env.DB.prepare(
    "INSERT INTO reviewers(name,password_hash,created_at) VALUES(?,?,?)",
  )
    .bind(name, await pbkdf2Hash(password), nowISO())
    .run();
  await audit(env, session.identity, session.role, "add_reviewer", name, "");
  return OK({ id: r.meta.last_row_id });
}

async function updateReviewer(env, request, id, session) {
  const body = await readJson(request);
  const row = await env.DB.prepare("SELECT id,name FROM reviewers WHERE id=?")
    .bind(id)
    .first();
  if (!row) throw new ApiError("REVIEWER_NOT_FOUND", "审核员不存在", 404);

  const cols = [];
  const args = [];
  if ("name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name) throw new ApiError("FIELD_INVALID", "审核员名称不能为空", 400);
    if (name.length > 32)
      throw new ApiError("FIELD_INVALID", "审核员名称不能超过 32 个字符", 400);
    const dup = await env.DB.prepare(
      "SELECT id FROM reviewers WHERE name=? AND id<>?",
    )
      .bind(name, id)
      .first();
    if (dup) throw new ApiError("REVIEWER_EXISTS", "该名称已存在", 409);
    cols.push("name=?");
    args.push(name);
  }
  if ("password" in body) {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 6)
      throw new ApiError("FIELD_INVALID", "密码至少 6 位", 400);
    cols.push("password_hash=?");
    args.push(await pbkdf2Hash(password));
  }
  if (cols.length) {
    await env.DB.prepare(`UPDATE reviewers SET ${cols.join(",")} WHERE id=?`)
      .bind(...args, id)
      .run();
  }
  await audit(
    env,
    session.identity,
    session.role,
    "update_reviewer",
    row.name,
    cols.length ? "已更新" : "无变更",
  );
  return OK({ updated: true });
}

async function deleteReviewer(env, id, session) {
  const row = await env.DB.prepare("SELECT id,name FROM reviewers WHERE id=?")
    .bind(id)
    .first();
  if (!row) throw new ApiError("REVIEWER_NOT_FOUND", "审核员不存在", 404);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM reviewers WHERE id=?").bind(id),
    // 同时吊销该审核员的会话
    env.DB.prepare("DELETE FROM admin_sessions WHERE role='reviewer' AND identity=?")
      .bind(row.name),
  ]);
  await audit(env, session.identity, session.role, "delete_reviewer", row.name, "");
  return OK({ deleted: true });
}

/* ---------- 超级管理员：审核记录 ---------- */

async function listAudit(env, url) {
  let limit = parseInt(url.searchParams.get("limit") || "100", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 500);
  const { results } = await env.DB.prepare(
    "SELECT id,actor,actor_role,action,target,detail,created_at FROM audit_logs ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all();
  return OK(
    results.map((r) => ({
      id: r.id,
      actor: r.actor,
      actorRole: r.actor_role,
      action: r.action,
      target: r.target,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  );
}

/* ---------- 超级管理员：条目直接管理（立即生效） ---------- */

async function createMember(env, request, session) {
  const body = await readJson(request);
  assertAllowedAndValid(body, true);
  const obj = sanitizeChanges(body);
  const r = await insertMemberStmt(env, obj).run();
  await audit(
    env,
    session.identity,
    session.role,
    "create_member",
    obj.name,
    obj.username,
  );
  return OK({ id: r.meta.last_row_id });
}

async function updateMember(env, request, id, session) {
  const body = await readJson(request);
  assertAllowedAndValid(body, false);
  const mrow = await env.DB.prepare("SELECT id,name FROM members WHERE id=?")
    .bind(id)
    .first();
  if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "条目不存在", 404);
  const obj = sanitizeChanges(body);
  const { cols, args } = memberPairs(obj);
  if (cols.length) {
    await env.DB.prepare(`UPDATE members SET ${cols.join(",")} WHERE id=?`)
      .bind(...args, id)
      .run();
  }
  await audit(env, session.identity, session.role, "update_member", mrow.name, "");
  return OK({ updated: true });
}

async function deleteMember(env, id, session) {
  const mrow = await env.DB.prepare("SELECT id,name FROM members WHERE id=?")
    .bind(id)
    .first();
  if (!mrow) throw new ApiError("MEMBER_NOT_FOUND", "条目不存在", 404);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE submissions
          SET status='rejected', reason='目标条目已被删除，提交自动作废',
              reviewed_at=?, reviewed_by=?
        WHERE member_id=? AND status='pending'`,
    ).bind(nowISO(), session.identity, id),
    env.DB.prepare("DELETE FROM members WHERE id=?").bind(id),
  ]);
  await audit(env, session.identity, session.role, "delete_member", mrow.name, "");
  return OK({ deleted: true });
}

/* =============== 路由入口 =============== */
export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });

      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const p = url.pathname.replace(/\/+$/, "");

      if (p !== "/api" && !p.startsWith("/api/"))
        return ERR("NOT_FOUND", "Not Found", 404);

      const seg = p.split("/").filter(Boolean); // ['api', ...]
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      /* ---------- 公开接口 ---------- */
      if (seg[1] === "config" && seg.length === 2 && method === "GET")
        return await getConfig(env);

      if (seg[1] === "members" && seg.length === 2 && method === "GET")
        return await listMembers(env);

      if (seg[1] === "submissions" && seg.length === 2) {
        if (method === "POST") return await createSubmission(env, request, ip);
        if (method === "GET") {
          const session = await requireAdmin(env, request);
          return await listSubmissions(env, url); // 兼容别名
        }
      }

      /* ---------- 管理接口 ---------- */
      if (seg[1] === "admin") {
        if (seg.length === 3 && seg[2] === "login" && method === "POST")
          return await adminLogin(env, request, ip);

        const session = await requireAdmin(env, request);

        if (seg.length === 3 && seg[2] === "me" && method === "GET")
          return OK({ role: session.role, identity: session.identity });

        if (seg[2] === "submissions") {
          if (seg.length === 3 && method === "GET")
            return await listSubmissions(env, url);
          if (seg.length === 5 && seg[4] === "approve" && method === "POST")
            return await approveSubmission(env, Number(seg[3]), session);
          if (seg.length === 5 && seg[4] === "reject" && method === "POST")
            return await rejectSubmission(env, request, Number(seg[3]), session);
        }

        if (seg[2] === "audit") {
          assertSuper(session);
          if (seg.length === 3 && method === "GET")
            return await listAudit(env, url);
        }

        if (seg[2] === "reviewers") {
          assertSuper(session);
          if (seg.length === 3 && method === "GET")
            return await listReviewers(env);
          if (seg.length === 3 && method === "POST")
            return await createReviewer(env, request, session);
          if (seg.length === 4 && method === "PUT")
            return await updateReviewer(env, request, Number(seg[3]), session);
          if (seg.length === 4 && method === "DELETE")
            return await deleteReviewer(env, Number(seg[3]), session);
        }

        if (seg[2] === "members") {
          assertSuper(session);
          if (seg.length === 3 && method === "GET") return await listMembers(env);
          if (seg.length === 3 && method === "POST")
            return await createMember(env, request, session);
          if (seg.length === 4 && method === "PUT")
            return await updateMember(env, request, Number(seg[3]), session);
          if (seg.length === 4 && method === "DELETE")
            return await deleteMember(env, Number(seg[3]), session);
        }

        return ERR("NOT_FOUND", "Not Found", 404);
      }

      return ERR("NOT_FOUND", "Not Found", 404);
    } catch (e) {
      if (e instanceof ApiError) return ERR(e.code, e.message, e.status);
      console.error("[INTERNAL]", (e && e.stack) || e);
      return ERR("INTERNAL_ERROR", "服务器内部错误", 500);
    }
  },
};
