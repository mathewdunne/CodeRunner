# Plan 01 — V1 / MVP cleanup

## Context

V2 made the V1 dual-container architecture (sim + LSP) obsolete. The codebase
still carries:

- A `cleanupV1Containers()` helper that runs at startup to scrub V1 leftovers.
- Six unused V1-shaped columns on `ContainerLeaseRow`.
- A cookie name (`frc_v1_session`) and default-secret string with `v1` baked in.
- The entire `mvp/` source tree from the original prototype.
- Four obsolete decision logs (007–010) that documented V1 design choices.

This plan removes the dead source code, archives historical docs in-repo, and
deletes the `mvp/` source tree. The goal is a tree that reads as
"V2 is the system" with no V1 noise.

## Out of scope

- Test consolidation and the `app.test.ts` split — see [Plan 02](02-trim-tests-config.md).
- Removing the build queue / `RUN_CONCURRENCY` — see [Plan 02](02-trim-tests-config.md).
- Any UI changes — see [Plan 03](03-ui-scaffolding.md) and later.

## Dependencies

None. This can run independently of all other plans.

## Tasks

### 1. Remove `cleanupV1Containers()`

- Delete the method body in [apps/control/src/containers.ts](../../apps/control/src/containers.ts) at lines ~274–308.
- Find and remove the call site in `apps/control/src/app.ts` startup
  (search for `cleanupV1Containers`). The startup path should no longer call it.
- Confirm no other references remain (`grep -r cleanupV1Containers`).

**Acceptance:** `bun run typecheck` passes; `bun run dev:control` boots without
referencing V1 in startup logs.

### 2. Drop V1 columns from `container_leases`

- Add migration `apps/control/migrations/005_drop_v1_columns.sql` that drops:
  `sim_container`, `lsp_container`, `sim_port`, `lsp_port`, `state`,
  `lsp_state` from the `container_leases` table.
  - SQLite limitation: `ALTER TABLE ... DROP COLUMN` is supported in SQLite
    3.35+ (Bun bundles a recent version) — use `ALTER TABLE container_leases
    DROP COLUMN <name>` per column. If the runtime version turns out to be
    older, fall back to the create-new-table-and-copy pattern.
- Update [apps/control/src/storage.ts](../../apps/control/src/storage.ts) `ContainerLeaseRow` interface
  (lines ~44–57) — remove the six fields.
- Update read/write call sites in `storage.ts`, `containers.ts`. None of these
  fields are read on the V2 path; the writes can simply be deleted.

**Acceptance:** `bun run migrate` produces a clean DB with the new schema;
existing dev DBs at `data/app.db` migrate forward without error;
`bun run typecheck` passes.

### 3. Rename cookie and default secret

- Cookie name: change `frc_v1_session` → `frc_session` at [apps/control/src/cookies.ts:5](../../apps/control/src/cookies.ts:5).
- Acceptable to break existing classroom sessions — students re-login.
  No fallback-read needed.
- Default session secret string at [apps/control/src/config.ts:122](../../apps/control/src/config.ts:122) —
  drop the `v1` segment from the placeholder.

**Acceptance:** Web shell login flow still works end-to-end after the rename.

### 4. Archive `mvp/docs/` and delete `mvp/` source

- Create `docs/archive/mvp-docs/` and move the entire contents of `mvp/docs/`
  into it (including `Project-MVP.md`, `decisions/001…006.md`, any other
  files). Preserve relative structure.
- Delete the rest of `mvp/` (source code, `node_modules` if present,
  `package.json`, etc.).
- After deletion, `mvp/` no longer exists.

**Acceptance:** `mvp/` is gone; `docs/archive/mvp-docs/` exists with the
former `mvp/docs/` contents intact.

### 5. Archive obsolete V1 decisions

- Create `docs/decisions/archive/` if it doesn't exist.
- Move these four files into it:
  - `docs/decisions/007-v1-sim-container-orchestration.md`
  - `docs/decisions/008-v1-lsp-container-bridge.md`
  - `docs/decisions/009-lsp-reconnect-and-bridge-serialization.md`
  - `docs/decisions/010-gradle-project-cache-isolation.md`
- Update `docs/decisions/README.md` — note that 007–010 are archived under
  `archive/` and explain why (V1 is no longer the runtime model). Keep links
  to the archived files for traceability.

**Acceptance:** `docs/decisions/` lists only V2-active decisions (011, 012,
013, plus the README); archive folder has 007–010.

### 6. Scrub references to `mvp/` and V1

Update every file that references `mvp/` or describes V1 as the active
architecture. Files known to mention them:

- [AGENTS.md](../../AGENTS.md) — it lists the repo layout, references `mvp/`, and
  cites `mvp/Project-MVP.md` and `mvp/docs/decisions/` under "Key References".
  Update the layout to drop `mvp/`. Replace the references with pointers to
  `docs/archive/mvp-docs/` (note that historical context lives there).
- [CLAUDE.md](../../CLAUDE.md) — it just `@AGENTS.md`'s, but verify nothing
  else references `mvp/`.
- `README.md` (repo root) — if it links to the MVP, redirect to the archive
  path or remove.
- [docs/runbook.md](../runbook.md) — search for `mvp` references and update.
- [docs/V1-Design.md](../V1-Design.md) — keep as historical reference but add a
  one-paragraph header noting it's archived and that `docs/V2-Design.md` is the
  current source of truth.

**Acceptance:** `grep -ri "mvp/" .` (excluding the archive path itself and
`docs/V1-Design.md` historical references) returns nothing meaningful.

### 7. Remove status-tracker entry for V1 cruft

- [AGENTS.md](../../AGENTS.md) "Current Status" section lists V2 stages.
  No V1 changes needed there. Verify nothing else still says "V1 LSP" or
  "two-container" in present tense.

## Files modified / created / deleted

**Modified:**
- `apps/control/src/containers.ts` (delete `cleanupV1Containers` + caller)
- `apps/control/src/app.ts` (remove startup call)
- `apps/control/src/storage.ts` (drop V1 fields from `ContainerLeaseRow`)
- `apps/control/src/cookies.ts` (cookie name)
- `apps/control/src/config.ts` (default secret string)
- `docs/decisions/README.md` (note archived decisions)
- `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/runbook.md`, `docs/V1-Design.md`
  (scrub `mvp/` references)

**Created:**
- `apps/control/migrations/005_drop_v1_columns.sql`
- `docs/archive/mvp-docs/` (with former `mvp/docs/` contents)
- `docs/decisions/archive/` (with 007–010)

**Deleted:**
- `mvp/` (entire tree)
- `docs/decisions/007-v1-sim-container-orchestration.md` (moved to archive)
- `docs/decisions/008-v1-lsp-container-bridge.md` (moved)
- `docs/decisions/009-lsp-reconnect-and-bridge-serialization.md` (moved)
- `docs/decisions/010-gradle-project-cache-isolation.md` (moved)

## Verification

1. `bun install` — confirm no broken workspace references after `mvp/` deletion.
2. `bun run typecheck` — green.
3. `bun run test` — passes (V1-cleanup tests will fail until [Plan 02](02-trim-tests-config.md)
   removes them; if running this plan first, temporarily skip those two tests
   at `app.test.ts:634–667` and `:1572–1595` and note in the PR that Plan 02
   removes them).
4. `bun run migrate` — applies `005_drop_v1_columns.sql` cleanly on an existing
   dev DB.
5. `bun run dev:control` — boots; no startup log mentions V1 cleanup.
6. Manual sanity: log in, open the editor, run a build, see logs, stop. AS Lite
   connects. Editor proxy works. (Validates that the cookie rename + DB
   migration didn't break the happy path.)
7. `grep -ri "cleanupV1Containers" .` — no hits.
8. `grep -ri "mvp/" . --exclude-dir=docs/archive --exclude-dir=node_modules` —
   only intentional historical references in `docs/V1-Design.md`.
