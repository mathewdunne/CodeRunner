# Startup Gradle cache pruning — design

## Why

On 2026-11-16 the prod data disk (`/var/lib/coderunner/data`, 50 GB) filled
mid-class: every workspace request failed with `SQLITE_FULL`. 20 workspaces
each held a 1.2–2.2 GB `home/.gradle/caches`, which is mostly a copy of the
image's primed cache (`init-frc-setup` copies `/opt/frc-gradle-cache` into a
workspace whose `caches/` is missing). Nothing ever removes it, so disk use
grows by ~1.5 GB per student who has ever logged in. The disk was grown to
100 GB as a stopgap; this bounds the growth.

The VM is stopped between classes, so a cron job or periodic timer would
rarely fire; the prune must run at boot. Changing the VM's
`metadata_startup_script` forces terraform to replace the instance, so the
control plane (which starts on every boot) is the place for it.

## Goals

- Free the Gradle caches of workspaces nobody has used recently, on every
  control-plane start.
- Never corrupt a cache a student is about to use.

## Non-goals

- Pruning `project/build`, `backups/`, or anything else (decided: Gradle cache
  only).
- Periodic pruning while the VM stays up (decided: startup only).
- Demo mode (caches live in named volumes; decided: skip).
- Sharing the image cache read-only (`GRADLE_RO_DEP_CACHE`) — a separate,
  larger change to the workspace image.
- Reporting bytes freed.

## Approaches

1. **One-shot startup task in the control plane (chosen).** Runs in the
   background after `createApp` boots; testable TypeScript; ships with a
   normal release.
2. Fold it into `IdleManager`. Rejected: that sweep runs every few minutes,
   and pruning was decided to be startup-only.
3. VM startup script / cron via terraform. Rejected: the startup script is
   ForceNew on the instance, cron rarely fires on a mostly-stopped VM.

## Decided behaviour

- `GRADLE_CACHE_PRUNE_DAYS` (default **14**, non-negative integer, **0
  disables**). Skipped entirely in demo mode.
- Candidates: every directory `<dataDir>/users/ws_*`.
  - With a workspace row: idle when `last_accessed_at` is older than the
    cutoff.
  - Without a workspace row (orphan): always idle (decided: prune them too).
- Skip any candidate whose code container is actually running.
- Prune = rename `home/.gradle/caches` to
  `home/.gradle/caches.pruning-<timestamp>` (atomic, so a container starting
  mid-prune sees no `caches/` and re-seeds cleanly), then delete it in the
  background.
- Leftover `caches.pruning-*` directories (from an interrupted run) are
  deleted on the next run regardless of idleness.
- Report: one info log line per run with the cutoff, the pruned count, and the
  pruned workspace ids (decided: log summary only, no metric).

## Builder's calls (made by Claude, correctable)

- Env var name `GRADLE_CACHE_PRUNE_DAYS`.
- Only directory names starting with `ws_` are candidates.
- Running check via `docker inspect` of the workspace's code container.
- Failures are logged and never fail boot.
- Docs: `docs/reference/configuration.md`, operating docs mention, decision log
  049.
