# Startup Gradle Cache Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every control-plane start, delete `home/.gradle/caches` of workspaces idle longer than `GRADLE_CACHE_PRUNE_DAYS`.

**Architecture:** A pure-ish module `gradle-cache-prune.ts` scans `<dataDir>/users/ws_*`, decides idleness from an injected `lastAccessedAt` lookup, skips running containers via an injected `isRunning`, renames each idle cache to `caches.pruning-<ts>` and deletes those in the background. `createApp` fires it once (not awaited) when using the real Docker runtime, outside demo mode, with days > 0, and logs one summary line.

**Tech Stack:** Bun, TypeScript, `node:fs/promises`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-16-gradle-cache-prune-design.md`

## Global Constraints

- Env var `GRADLE_CACHE_PRUNE_DAYS`: non-negative integer, default `14`, `0` disables.
- Only `home/.gradle/caches` is ever removed; nothing else under a workspace.
- Skipped in demo mode.
- Candidates are directories under `<dataDir>/users/` whose name starts with `ws_`; no DB row ⇒ idle.
- Idle ⇔ `last_accessed_at` strictly older than `now - days`.
- Never fail boot; errors are logged.
- Report: one info log line (cutoff days, pruned count, pruned ids). No metric, no byte counts.
- Run `bun run check:fix` before finishing; update `docs/` (configuration reference + decision log 049).

## Review Focus

- `<dataDir>/users` missing (fresh install) → no-op, no throw. Test in Task 2.
- `isRunning` throws (Docker unreachable) → treat as running, skip, continue with others. Test in Task 2.
- `ws_*` entry that is a file, or has no `home/.gradle/caches` → skipped silently. Test in Task 2.
- A failure on one workspace → the others still get pruned (per-entry try/catch). Covered by the `isRunning` throws test in Task 2.
- `last_accessed_at` exactly at the cutoff → kept. Test in Task 2.

---

### Task 1: Config field `gradleCachePruneDays`

**Files:**
- Modify: `apps/control/src/config.ts` (type `ControlConfig`, `ControlConfigInput`, `loadControlConfig`, new `parseNonNegativeInteger`)
- Test: `apps/control/src/__tests__/config.test.ts`

**Interfaces:**
- Produces: `ControlConfig.gradleCachePruneDays: number`; input accepts `number | string`.

- [ ] **Step 1: Failing tests** — `gradleCachePruneDays` defaults to `14`; `"0"` → `0`; `"30"` → `30`; `"-1"` and `"abc"` throw `/GRADLE_CACHE_PRUNE_DAYS must be a non-negative integer/`.
- [ ] **Step 2:** `LESSONS_CATALOG_REPO= bun test apps/control/src/__tests__/config.test.ts` → FAIL.
- [ ] **Step 3:** Add `parseNonNegativeInteger(value, fallback, name)` mirroring `parsePositiveInteger` (accepts 0); wire `input.gradleCachePruneDays ?? Bun.env.GRADLE_CACHE_PRUNE_DAYS`, fallback 14.
- [ ] **Step 4:** Re-run → PASS. Commit `feat(control): add GRADLE_CACHE_PRUNE_DAYS config`.

### Task 2: Prune module

**Files:**
- Create: `apps/control/src/gradle-cache-prune.ts`
- Test: `apps/control/src/__tests__/gradle-cache-prune.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GradleCachePruneOptions = {
    dataDir: string;
    days: number;
    lastAccessedAt: (workspaceId: string) => string | null; // null = no workspace row
    isRunning: (workspaceId: string) => Promise<boolean>;
    now?: Date;
  };
  export type GradleCachePruneResult = { pruned: string[]; removal: Promise<void> };
  export async function pruneIdleGradleCaches(o: GradleCachePruneOptions): Promise<GradleCachePruneResult>;
  ```
  `removal` resolves when every `caches.pruning-*` dir (new and leftover) is deleted; it never rejects (errors logged).

Tests build a temp `dataDir` with `users/<id>/home/.gradle/caches/marker` and assert after `await result.removal`:

- [ ] **Step 1: Failing tests**
  - `prunes caches of a workspace idle past the cutoff` — accessed 15 days ago, days 14 → `pruned` = [id], `caches` gone, `home/.gradle/wrapper` (sibling) still present.
  - `keeps a recently used workspace` — accessed 1 day ago → untouched.
  - `keeps a workspace accessed exactly at the cutoff`.
  - `prunes an orphan dir with no workspace row` — `lastAccessedAt` returns null.
  - `skips a running workspace` and `skips when isRunning throws, continuing with others`.
  - `removes leftover caches.pruning-* dirs even for active workspaces`.
  - `ignores non-ws_ entries, files named ws_*, and workspaces without a caches dir`.
  - `is a no-op when users/ does not exist`.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement. Per entry: try/catch; `rename(caches, caches.pruning-<Date.now()>)`. Collect all `caches.pruning-*` under every `ws_*/home/.gradle` and `rm({recursive, force})` them in `removal` (started, not awaited, before returning).
- [ ] **Step 4:** Run → PASS. Commit `feat(control): prune idle workspace Gradle caches`.

### Task 3: Wire into boot, docs, decision log

**Files:**
- Modify: `apps/control/src/containers/local-docker-runtime-provider.ts` — add `async isCodeContainerRunning(workspaceId: WorkspaceId): Promise<boolean>` (`inspectContainer(this.dockerRunner, codeContainerName(id))?.State?.Running === true`).
- Modify: `apps/control/src/app.ts` — after `idle.start()`, when `!configuredRuntimeProvider && !storage.config.demo && storage.config.gradleCachePruneDays > 0`, call `pruneIdleGradleCaches` without awaiting; log `bootLog.info("pruned idle Gradle caches", { cutoffDays, count, workspaceIds })`; `.catch` → `bootLog.warn`. `lastAccessedAt` = `storage.findWorkspaceById(id)?.last_accessed_at ?? null`.
- Modify: `apps/control/src/main.ts` — add `gradleCachePruneDays` to the config log line.
- Modify: `docs/reference/configuration.md` (env var row), `docs/operating/day-to-day.md` (one paragraph on disk use).
- Create: `docs/decisions/049-startup-gradle-cache-prune.md`.

- [ ] **Step 1:** Implement the above.
- [ ] **Step 2:** `bun run typecheck` → clean; `LESSONS_CATALOG_REPO= bun run test` → all pass; `bun run check:fix` → no remaining issues.
- [ ] **Step 3:** Commit `feat(control): run Gradle cache prune at startup` + docs.
