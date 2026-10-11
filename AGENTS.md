# AGENTS.md

Compact guidance for working in this repo. Every line answers: "Would an agent likely miss this without help?"

## What this is

Cloudflare Workers + D1 (SQLite) app. **X友跨翻车列表** (a list of X/Twitter friends' 翻车 incidents): a public SPA timeline, anonymous add/edit suggestions gated by Cloudflare Turnstile, and an admin moderation queue with reviewer + super-admin roles. All responses are `{ ok, data|error }`.

> ⚠️ Reconstructed from the older "社团成员时间线" app. Real-name verification (`SERVER_PEPPER`, `verifyToken`) and 届/generation were **removed**. Do not reintroduce them.

## Layout (small, but non-obvious)

- `src/index.js` — the **entire** backend: routing + every API handler in one file. No framework, no router lib.
- `content/index.html` — the **frontend SPA**, served directly as a Worker asset. There is **no build step**; this single static file is the UI. It also contains a **full in-browser mock backend** (`handleMock`), so most UI work can be verified with no server.
- `schema.sql` — the only DB schema. D1 has no migrations; this is re-applied manually and **DROPs every table first** (destroys data).
- `wrangler.toml` — Worker config. `database_id` is already filled in.
- `API.md` — authoritative API reference. `README.md` — Chinese user-facing docs.

## Commands

```bash
# Local dev (needs .dev.vars — see gotchas)
npx wrangler dev
npx wrangler d1 execute you_are_mtf_db --local --file=./schema.sql   # init local DB

# Remote
npx wrangler d1 execute you_are_mtf_db --remote --file=./schema.sql   # init/reset schema
npx wrangler deploy
```

There is **no package.json, no tests, no lint, no typecheck, no CI**. Do not run `npm test`/`npm run lint` — they do not exist. Verification is manual (README "冒烟测试" curl script), or `node --check` on extracted JS.

## Secrets & local config (easy to get wrong)

- `ADMIN_PASSWORD` (`npx wrangler secret put ADMIN_PASSWORD`) — the **super-admin** password. Required for super login; compared in constant time against `env.ADMIN_PASSWORD`. Not stored in DB.
- `TURNSTILE_SECRET_KEY` + `TURNSTILE_SITE_KEY` (`npx wrangler secret put ...`) — optional. Turnstile is **enforced only when `TURNSTILE_SECRET_KEY` is set**; `TURNSTILE_SITE_KEY` is handed to the frontend via `GET /api/config`.
- `.dev.vars` (gitignored) holds local values. **Current contents:** `SERVER_PEPPER=123456` (now unused — safe to delete), `ADMIN_PASSWORD=aaaaa`. Turnstile keys are unset locally, so submissions skip verification.
- Reviewers are **DB rows** (`reviewers` table), not env vars: create them via `POST /api/admin/reviewers` after logging in as super admin. Passwords are PBKDF2-SHA256 (100k rounds) hashed.

## Behavior gotchas

- **Submission field whitelist:** `username / name / crashDate / bio / avatar / tags`. Any other key (incl. `id`, `memberId`) → `FIELD_FORBIDDEN`. `create` requires `username / name / crashDate` (`FIELD_MISSING`).
- `crashDate` must be `YYYY-MM-DD` **and a real calendar date**. Username is normalized (strip `@`/URL/path, lowercase) then must match `^[a-z0-9_]{1,15}$`. Avatar bare domains auto-prefixed with `https://`; only http/https allowed (so `javascript:`/`data:` rejected). Username is **not unique** (same person may have multiple incidents).
- `POST /api/submissions` ordering: rate-limit → parse → `type` check → **Turnstile** → field validation. So a validated Turnstile token is consumed even if later field validation fails.
- `POST /api/admin/login` also verifies Turnstile when `TURNSTILE_SECRET_KEY` is set (order: rate-limit → parse → **Turnstile** → password), so brute force can't even reach the password check. The login form mounts its own widget and sends `turnstileToken`.
- Roles: session row has `role` (`super` / `reviewer`). `/admin/audit`, `/admin/reviewers`, `/admin/members` are **super-only**; a reviewer gets `403 FORBIDDEN`. Submission review endpoints work for both.
- `adminToken` is Bearer, 2h, stored in `admin_sessions` (revocable). Deleting a reviewer atomically revokes that reviewer's sessions.
- Admin reject requires a non-empty `reason` → `REASON_REQUIRED`. Approving/rejecting an already-finalized submission returns `409 ALREADY_REVIEWED`. Deleting a member voids its pending submissions (D1 `batch()`); approve on a deleted target returns `404 MEMBER_NOT_FOUND`. Reviews are last-write-wins, no conflict detection.
- `GET /api/admin/submissions` with an invalid `status` returns `[]` (not an error).
- Rate limits via D1 `rate_limits` counters: `admin/login` 5/min, `submissions` 10/hr. Request body cap 64KB → `413 BODY_TOO_LARGE`.
- **`USE_MOCK`** in `content/index.html` is currently `true`; the SPA uses an in-browser mock and never hits the Worker. **Flip it to `false` before deploying** for real. Mock creds: super `admin888`, reviewers `审核员甲/reviewer1`, `审核员乙/reviewer2`.
- Note the `GET /api/submissions` alias (without `admin/` prefix) requires a Bearer token too.

## API docs

`API.md` and `README.md` (Chinese) are the authoritative API references. Prefer them over guessing routes.
