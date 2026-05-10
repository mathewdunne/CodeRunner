# Plan 07 — Operational hardening

## Context

After Plans 01–06 land, the system is feature-complete for the planned
post-V2 batch. This plan tightens the operational story:

- **Container concurrency cap.** Today there's no hard ceiling on how many
  student containers can run at once. Idle teardown helps but doesn't prevent
  a 50-student simultaneous sign-in from blowing past host capacity.
- **Audit log for admin actions.** Once admins can delete users and stop
  containers (Plan 05), "who did what when" matters. A small audit log pays
  for itself the first time something goes wrong.
- **CI workflow.** `bun run test` runs locally; nothing enforces it on PRs.
  GitHub Actions running typecheck + tests + build gives us a safety net.

The three items are loosely related — operational maturity — and small
enough to bundle into one plan.

## Out of scope

- Real-time observability beyond polling (admin view 5s polling stays).
- Time-series metrics / Prometheus / Grafana.
- Production deployment + TLS.
- Secrets management beyond `.env` (still classroom-only).
- Audit log UI deep-search / filtering — basic chronological list is fine
  for v1.

## Dependencies

- **[Plan 05](05-auth-and-admin.md)** for audit log (records admin actions
  and uses the role system) and concurrency cap (ties admission to the user
  identity).
- The CI portion is independent and can be lifted out of this plan and
  landed earlier if you want CI sooner.

## Tasks

### A. Container concurrency cap

#### A.1 Config

- Add `MAX_ACTIVE_CONTAINERS` to [apps/control/src/config.ts](../../apps/control/src/config.ts).
  Default: `10` (matches the runbook's documented host sizing).
- Document in [docs/runbook.md](../runbook.md) — explain that this is total
  *running* student containers, not total users. Idle/stopped containers
  don't count.

#### A.2 Admission control

- New helper in [apps/control/src/containers.ts](../../apps/control/src/containers.ts):
  `countRunningContainers()` returns the live count from Docker (label
  filter on `frc-sim.version=v2`).
- In `ensureCodeContainer()`: before allocating ports / starting a new
  container, check `count >= MAX_ACTIVE_CONTAINERS`. If at cap, throw a
  typed `CapacityExceededError`.
- App-level handler converts `CapacityExceededError` to HTTP 503 with body
  `{ error: "capacity", limit, current }`.
- Web shell (login flow + IDE bootstrap) catches the 503 and shows a
  toast: "Server at capacity — your coach has been notified. Please try
  again in a few minutes." (No actual notification yet — that's a separate
  item; the message just sets expectations.)

#### A.3 Admin override

- The admin can bump the cap at runtime without restarting:
  `POST /admin/config/max-active-containers` with `{ value: number }`.
  Authorization: `requireAdmin` from [Plan 05](05-auth-and-admin.md) §A.7.2.
  Persists in SQLite (new `runtime_config` k/v table) and in-memory.
- `Dashboard.tsx` (from Plan 05) shows current vs cap. Admin can edit
  inline.

#### A.4 Tests

- Unit: `ensureCodeContainer` throws `CapacityExceededError` when at cap.
- Integration: 11th sign-in (with cap=10) gets 503; the existing 10
  containers continue working.
- Admin override: bumping cap via admin endpoint allows the 11th to start.

### B. Audit log

#### B.1 Schema

- Migration `apps/control/migrations/009_audit_log.sql`:
  ```sql
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT NOT NULL,        -- betterauth user id
    actor_email TEXT NOT NULL,           -- denormalized for log readability
    action TEXT NOT NULL,                -- e.g. "user.delete", "container.stop"
    target_kind TEXT,                    -- "user" | "workspace" | "container" | "allowlist"
    target_id TEXT,
    metadata_json TEXT,                  -- JSON blob with action-specific detail
    occurred_at INTEGER NOT NULL         -- unix ms
  );
  CREATE INDEX audit_log_occurred_at ON audit_log (occurred_at DESC);
  CREATE INDEX audit_log_actor ON audit_log (actor_user_id);
  ```
- Migration number is `009` because Plan 05 uses 007 (betterauth tables) and
  008 (user roles).

#### B.2 Recording helper

- New module `apps/control/src/audit.ts` exporting `recordAuditEvent({
  actor, action, target?, metadata? })`.
- Wire into every privileged action introduced in Plan 05's admin endpoints:
  - `user.delete`
  - `user.promote` / `user.demote`
  - `workspace.delete` / `workspace.backup` / `workspace.restore` /
    `workspace.seed-template`
  - `container.stop` / `container.restart-code`
  - `allowlist.add` / `allowlist.remove`
  - `config.max-active-containers` (from task A.3)
- Auto-records on success only. Failures don't pollute the log.

#### B.3 Admin UI

- New page at `apps/web/src/admin/pages/AuditLog.tsx`. shadcn `Table`
  rendering: time, actor email, action, target, metadata summary.
- `GET /admin/audit-log?limit=100&before=<id>` paginates by id descending.
  Gated by `requireAdmin` (Plan 05 §A.7.2).
- Filters: actor email contains, action prefix, last-N-days. Keep simple —
  no full-text search.
- Expandable row to show full `metadata_json`.

#### B.4 Retention

- Audit log entries are kept indefinitely for v1. Cheap; a classroom
  generates dozens of rows/year, not millions.
- Add a manual prune CLI for later: `bun run audit:prune --before 2024-01-01`.

#### B.5 Tests

- Unit: `recordAuditEvent` writes correct row.
- Integration: each Plan 05 admin endpoint produces an audit row with the
  expected `action` and `target_id`.
- Admin UI: pagination + filters return expected rows.

### C. CI workflow

#### C.1 GitHub Actions

- Add `.github/workflows/ci.yml`:
  ```yaml
  name: CI
  on:
    push:
      branches: [main]
    pull_request:

  jobs:
    test:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            submodules: recursive
        - uses: oven-sh/setup-bun@v1
          with:
            bun-version: latest
        - run: bun install --frozen-lockfile
        - run: bun run typecheck
        - run: bun run test
  ```
- The web build (`bun run build:web`) and AS Lite build
  (`bun run build:ascope`) require additional setup (AS Lite needs the
  submodule + patches applied via `bun run apply:ascope-patches`). Add a
  second job that runs those, but mark it non-blocking until verified
  to pass on the runner — they can be brittle from cold env.

#### C.2 Docker image build

- Optional second job: build the V2 code container image
  (`bun run docker:build:code`) on tagged releases only. Skip on every PR
  because it's slow.
- Don't push to a registry yet — that's deployment, out of scope.

#### C.3 Branch protection

- Document in the runbook that `main` should require the CI job to pass
  before merge. Setting branch protection itself is a GitHub repo setting,
  not a code change — note in the PR description.

#### C.4 Tests aren't expected to fail

- If any test is flaky (timing-dependent, Docker-dependent), mark it
  explicitly with a skip + TODO comment. Don't let CI start with `if:
  always()` workarounds — fix or skip.

## Files modified / created / deleted

**Modified:**
- `apps/control/src/config.ts` (`MAX_ACTIVE_CONTAINERS`)
- `apps/control/src/containers.ts` (`countRunningContainers`,
  `CapacityExceededError`, admission check in `ensureCodeContainer`)
- `apps/control/src/app.ts` (503 handler, `/admin/config/...` endpoint,
  audit-event wiring on every existing admin endpoint)
- `apps/web/src/admin/pages/Dashboard.tsx` (cap display + edit control)
- `apps/web/src/admin/AdminLayout.tsx` (add Audit Log nav entry)
- `docs/runbook.md` (cap + audit log + CI sections)

**Created:**
- `apps/control/migrations/009_audit_log.sql`
- `apps/control/migrations/010_runtime_config.sql` (k/v table for
  cap override)
- `apps/control/src/audit.ts`
- `apps/control/src/__tests__/audit.test.ts`
- `apps/control/src/__tests__/capacity.test.ts`
- `apps/web/src/admin/pages/AuditLog.tsx`
- `scripts/audit-prune.ts` (manual prune CLI)
- `.github/workflows/ci.yml`

**Deleted:** none.

## Verification

1. **Capacity cap:**
   - Set `MAX_ACTIVE_CONTAINERS=2`. Sign in three students. Third sees the
     503 toast. Existing two work normally.
   - As admin, bump cap to 3 via the admin UI. Third student refreshes;
     their container starts.
   - Restart the control plane. Cap value persists (from `runtime_config`).
2. **Audit log:**
   - Trigger every audited action: promote a user, stop a container,
     restore a backup, add an allowlist entry, change the cap. Each appears
     in the audit log page with the right actor + target + metadata.
   - Sign in as a student, navigate to `/admin/audit-log` — 403.
   - Filter by your own email, see only your rows.
3. **CI:**
   - Push a branch, open a PR. CI runs, types/test pass.
   - Intentionally break a test, push — CI fails, status check on the PR
     turns red. Revert.
   - Confirm `actions/checkout@v4` pulled the AS Lite submodule.
4. **Runbook:** the new sections describe the cap, the audit log retention
   policy, and how to require CI passing on `main`.
