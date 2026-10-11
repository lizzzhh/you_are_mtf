-- X友跨翻车列表 · D1 表结构
-- ⚠️ 本项目已从「社团成员时间线」重构为「翻车列表」，表结构与旧版不兼容。
--    重新执行本文件会先 DROP 既有表（清空数据）再重建，请确认后再执行。
--    本地：npx wrangler d1 execute you_are_mtf_db --local --file=./schema.sql
--    远程：npx wrangler d1 execute you_are_mtf_db --remote --file=./schema.sql

DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS submissions;
DROP TABLE IF EXISTS reviewers;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS verify_tokens; -- 旧表：实名验证机制已移除

-- 翻车条目
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,                 -- X(Twitter) 用户名，不含 @，小写
  name       TEXT NOT NULL,                 -- 昵称 / 显示名
  crash_date TEXT NOT NULL,                 -- 翻车日期 YYYY-MM-DD（前台按月分组）
  bio        TEXT NOT NULL DEFAULT '',      -- 翻车详情
  avatar     TEXT NOT NULL DEFAULT '',      -- 头像链接（用户自行 F12 获取）
  tags       TEXT NOT NULL DEFAULT '[]',    -- JSON 字符串数组
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_crash_date ON members(crash_date);

-- 提交（新增 / 修改建议），所有条目变更都要经过审核
CREATE TABLE IF NOT EXISTS submissions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL DEFAULT 'update', -- create | update
  member_id       INTEGER,                        -- update 时有值；create 时为 NULL
  member_name     TEXT NOT NULL DEFAULT '',       -- 提交时刻的昵称快照
  member_username TEXT NOT NULL DEFAULT '',       -- 提交时刻的用户名快照
  changes         TEXT NOT NULL,                  -- 变更字段集（JSON）
  old_data        TEXT NOT NULL,                  -- 提交时刻旧值快照（JSON）
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected
  reason          TEXT,
  reviewed_at     TEXT,
  reviewed_by     TEXT                            -- 处理人（审核员名 / 超级管理员）
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status, created_at);

-- 审核员（超级管理员使用环境变量 ADMIN_PASSWORD，不属于本表）
CREATE TABLE IF NOT EXISTS reviewers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,            -- 审核员显示名（同时是登录身份标识）
  password_hash TEXT NOT NULL,                   -- PBKDF2 慢哈希，格式 pbkdf2$轮数$盐$摘要
  created_at    TEXT NOT NULL
);

-- 管理会话：支持服务端吊销，记录角色与身份
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'reviewer',   -- super | reviewer
  identity   TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL                    -- unix 毫秒
);

-- 审核 / 审计记录
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL DEFAULT '',           -- 操作人显示名
  actor_role TEXT NOT NULL DEFAULT '',           -- super | reviewer
  action     TEXT NOT NULL,                      -- login / approve / reject / ...
  target     TEXT NOT NULL DEFAULT '',           -- 操作对象简述
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- 限流表
CREATE TABLE IF NOT EXISTS rate_limits (
  ip       TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits ON rate_limits(endpoint, ip, ts);
