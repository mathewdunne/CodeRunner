# 049 — Prune idle workspace Gradle caches at startup

## Context

On 2026-11-16 the prod data disk (50 GB) filled mid-class and every
workspace request failed with `SQLITE_FULL`. Each of the 20 workspaces held a
1.2–2.2 GB `home/.gradle/caches`, mostly a copy of the image's primed cache
(`init-frc-setup` copies `/opt/frc-gradle-cache` into any workspace without
`caches/`). Nothing removed it, so disk use grew by ~1.5 GB for every student
who had ever signed in. The disk was grown to 100 GB as a stopgap.

## Decision

On every start, the control plane deletes `home/.gradle/caches` of each
`<dataDir>/users/ws_*` workspace whose `last_accessed_at` is older than
`GRADLE_CACHE_PRUNE_DAYS` (default 14, `0` disables). Folders with no
workspace row count as idle. Workspaces whose code container is running are
skipped. It runs in the background and logs one summary line. Demo mode is
skipped (caches live in named volumes there).

Each cache is renamed to `caches.pruning-<ts>` before it is deleted. The
rename is atomic, so a container that starts mid-prune sees no `caches/` and
re-seeds cleanly instead of keeping a half-deleted cache. Leftover
`caches.pruning-*` folders are deleted on the next start.

**Why startup, not a timer or cron:** the prod VM is stopped between classes,
so periodic jobs rarely fire, while the control plane starts on every boot.
Changing the VM's `metadata_startup_script` would make terraform replace the
instance.

**Why only the Gradle cache:** it is regenerable without the network (the
image re-seeds it) and is ~80% of a workspace's size. `project/build` lives in
the student's project folder and is left alone.

## Not done

Sharing the image cache read-only (`GRADLE_RO_DEP_CACHE`) would remove the
per-workspace copy entirely, but changes the workspace image's init logic and
needs the real-image Java smoke (decision 038). Revisit if active-student
count alone outgrows the disk.
