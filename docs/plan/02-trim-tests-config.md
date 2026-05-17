# Plan 02 — Trim tests, config, and the build queue

## Context

Tests, environment variables, scripts, and the build queue accumulated
stage-by-stage during V1/V2 development. Several no longer earn their keep:

- **Build queue.** [apps/control/src/runs.ts](../../apps/control/src/runs.ts) implements a job queue with
  `RUN_CONCURRENCY` enforcement to throttle concurrent Gradle builds. With
  per-student containers each capped at 2.5 GB and small classroom sizes, the
  queue's risk-mitigation value no longer outweighs the maintenance cost.
  **Decision: remove entirely.**
- **One test file, 2,207 lines.** [apps/control/src/app.test.ts](../../apps/control/src/app.test.ts) is a single
  monolith covering everything from session cookies to V1 cleanup to the
  editor proxy. Split by concern.
- **One-shot verification scripts.** `verify-v2-two-user.ts` and
  `verify-v2-three-user-smoke.ts` were stage gates during V2-1…V2-6.
  `app.test.ts` covers the same flows; the standalone scripts are dead weight.
- **Stale env vars.** `RUN_CONCURRENCY` goes away with the queue. Other vars
  deserve a quick audit to confirm each still earns its place.

## Out of scope

- Touching V1 column drops, cookie renames, or `mvp/` deletion — see [Plan 01](01-cleanup-v1-mvp.md).
- Removing idle teardown — still useful for classroom resource management.
- UI changes — see [Plan 03](03-ui-scaffolding.md).

## Dependencies

[Plan 01](01-cleanup-v1-mvp.md) lands cleaner first. Plan 02 removes the V1
cleanup tests that Plan 01 deletes the helper for; if Plan 01 lands first the
test removals are mechanical, otherwise this plan must coordinate the helper
deletion too. They can run in parallel but expect a small merge conflict in
`app.test.ts`.

## Tasks

### 1. Remove the build queue

**Control plane** ([apps/control/src/runs.ts](../../apps/control/src/runs.ts)):

- Drop the `RunJob` "queued" state (`RunJob` discriminated union, ~line 38).
- Remove the `queue: RunJob[]` field on `RunManager` (~line 164).
- Remove the `activeBuilds.size < this.storage.config.runConcurrency` check
  (~line 273).
- `/run` should immediately transition to `building`. No queue position, no
  wait state.
- Remove the queue-flush / queue-promote logic that runs when a build
  completes.

**Contracts** ([packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)):

- Remove the `"queue"` variant from `RunServerMessage`.
- Remove `queueDepth` / `queuePosition` fields wherever they appear.
- Remove `"queued"` from any `RunStatus` union.

**Web shell** ([apps/web/src/main.tsx:17](../../apps/web/src/main.tsx:17)):

- Remove `"queued"` from the `RunStatus` union.
- Remove queue-info state (`queueInfo` near line 50).
- Remove the queue rendering in the topbar.
- (Plan 03 will rewrite the shell anyway — keep this change minimal so it
  doesn't conflict.)

**Acceptance:** `bun run typecheck` and `bun run test` green; running a build
no longer ever returns a `queue` message.

### 2. Remove `RUN_CONCURRENCY`

- Drop the `runConcurrency` field from the loaded config in
  [apps/control/src/config.ts](../../apps/control/src/config.ts) and any references in `storage.ts` /
  `runs.ts`.
- Remove the var from `.env.example` (if present), runbook docs, and any
  migration that referenced it.

**Acceptance:** `grep -ri "RUN_CONCURRENCY\|runConcurrency" apps/` returns
nothing.

### 3. Split `app.test.ts`

Move tests out of the 2,207-line monolith into focused files under
`apps/control/src/__tests__/`. Keep `bun run test` green throughout — split in
small commits if helpful.

| New file | Source line range (approx, current `app.test.ts`) | Covers |
| --- | --- | --- |
| `auth.test.ts` | 304–390 | Session skeleton, cookie validation |
| `routing.test.ts` | 392–475 | Static shell, heartbeat, cross-workspace rejection |
| `containers.test.ts` | 476–767, 1043–1089 | V2 orchestration, port allocation, adoption, status |
| `runs.test.ts` | 768–956 (post-queue cleanup) | Run lifecycle, log streaming, timeout |
| `proxy.test.ts` | 957–1042, 1802–2207 | AS Lite, NT4, editor proxy, header stripping |
| `idle-and-admin.test.ts` | 1090–1568 | Idle teardown, admin endpoints, backup/restore |
| `reconciliation.test.ts` | 1571–1799 | V2-6 lease recovery, adoption validation |

After the split, delete the old `app.test.ts`.

**Test fixtures.** If shared setup (alice/bob fixtures, test harness) lives at
the top of the old file, extract to `apps/control/src/__tests__/helpers.ts`.

**Acceptance:** All tests pass under `bun run test`. Each file is
self-contained (or imports from `helpers.ts`). No test file exceeds ~500 lines.

### 4. Drop redundant / V1 tests

Delete during the split (don't bring forward into the new files):

- `cleanupV1Containers` tests at `app.test.ts:634–667` and `:1572–1595`.
- Queue position / queue depth assertions in the run-queue test group
  (lines 768–956). Keep log-streaming and timeout tests; drop everything that
  references the removed queue state.
- Any test asserting on the dropped V1 columns (`sim_container`,
  `lsp_container`, etc.) from Plan 01.

### 5. Delete one-shot verification scripts

- Delete [scripts/verify-v2-two-user.ts](../../scripts/verify-v2-two-user.ts).
- Delete [scripts/verify-v2-three-user-smoke.ts](../../scripts/verify-v2-three-user-smoke.ts).
- Remove `verify:v2:two-user` and `verify:v2:three-user` from
  [package.json](../../package.json) scripts.
- Update [docs/runbook.md](../runbook.md) — remove references to those scripts; the
  `bun run test` integration suite is the new source of truth for multi-user
  isolation coverage.

**Keep:** `verify:ascope` (smoke tests AS Lite build), `measure`
([scripts/measure-resources.ts](../../scripts/measure-resources.ts)), `backup`, `restore`, the
`docker:build:code` and `docker:cleanup` helpers.

### 6. Audit env vars

Walk [apps/control/src/config.ts:loadControlConfig](../../apps/control/src/config.ts) and confirm each
remaining var earns its place. Expected post-trim list (verify during
execution):

- Paths: `FRC_DATA_DIR`, `FRC_DB_PATH`, `FRC_TEMPLATE_DIR`,
  `FRC_MIGRATIONS_DIR`, `FRC_WEB_DIST_DIR`, `FRC_ASCOPE_DIST_DIR`
- Auth/session: `CODERUNNER_SESSION_SECRET`, `ADMIN_TOKEN`
- Docker: `FRC_DOCKER_PATH`, `FRC_CONTAINER_USER`, `FRC_UID`, `FRC_GID`
- Container image: `CODE_IMAGE`, `CODE_MEMORY_LIMIT`
- Port ranges: `SIM_PORT_RANGE`, `VSCODE_PORT_RANGE` (and a third range for
  HALSim WS will be added in Plan 04)
- Timeouts: `RUN_BUILD_TIMEOUT_MS`, `SIM_STARTUP_TIMEOUT_MS`
- Lifecycle: `FRC_CONTAINER_AUTO_START`, `IDLE_STOP_MINUTES`,
  `IDLE_CHECK_INTERVAL_MS`

If any of those have no callers post-trim, propose dropping them in the PR
description rather than silently removing.

### 7. Update `docs/runbook.md`

- Remove the queue-related sections (queue saturation, RUN_CONCURRENCY tuning).
- Update the env-var reference table to match the post-trim set.
- Update verification commands — the runbook should point at `bun run test`
  and the `measure` script, not `verify:v2:*`.
- Update host sizing notes if they referenced queue behavior.

## Files modified / created / deleted

**Modified:**
- `apps/control/src/runs.ts` (queue removal)
- `apps/control/src/config.ts` (drop `RUN_CONCURRENCY`)
- `apps/control/src/storage.ts` (drop queue-related rows if any)
- `packages/contracts/src/index.ts` (remove queue messages)
- `apps/web/src/main.tsx` (drop "queued" union member, queue UI)
- `package.json` (drop verify scripts)
- `docs/runbook.md`

**Created:**
- `apps/control/src/__tests__/auth.test.ts`
- `apps/control/src/__tests__/routing.test.ts`
- `apps/control/src/__tests__/containers.test.ts`
- `apps/control/src/__tests__/runs.test.ts`
- `apps/control/src/__tests__/proxy.test.ts`
- `apps/control/src/__tests__/idle-and-admin.test.ts`
- `apps/control/src/__tests__/reconciliation.test.ts`
- `apps/control/src/__tests__/helpers.ts` (if shared fixtures extracted)

**Deleted:**
- `apps/control/src/app.test.ts`
- `scripts/verify-v2-two-user.ts`
- `scripts/verify-v2-three-user-smoke.ts`

## Verification

1. `bun run typecheck` — green.
2. `bun run test` — green; total assertion count not lower than before
   excluding the intentionally-removed queue/V1 assertions.
3. Boot the control plane (`bun run dev:control`); log in as two users in two
   browsers; run a build in each. Both build immediately, neither shows
   queueing UI, both stream logs cleanly.
4. `bun run measure` produces a sensible snapshot (validates that resource
   measurement still works post-trim).
5. `grep -ri "RUN_CONCURRENCY\|runConcurrency\|queue:" apps/control/src/` —
   no functional references (only test names that mention "queue"
   conceptually if any remain).
