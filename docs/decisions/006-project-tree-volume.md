# 006 — Project tree shared via Docker named volume

**Status:** Implemented (Post-MVP M2 — foundation for jdtls)
**Date:** 2026-05-01

## Context

Adding jdtls as a sidecar container (decision 007) introduces a second consumer of `/workspace/project`. jdtls needs to read the project sources, the `build.gradle`, `vendordeps/`, and the user's edits, and it must see the same bytes the sim is about to compile and run.

Three options were on the table when planning M2:

1. Bake the project into both images independently. The backend writes `Robot.java` to both via two `docker exec` calls.
2. Share `/workspace/project` between the two containers via a Docker named volume.
3. Don't share state at all. The browser's LSP messages (`textDocument/didOpen`/`didChange`) become the source of truth for jdtls; the sim still has its own baked copy and `POST /file` only writes there.

## Decision

Option 2 — a Docker named volume `frc-project` mounted at `/workspace/project` on both `frc-sim-mvp` and `frc-lsp-mvp`.

## Why

- **No write fanout.** A single `docker exec frc-sim-mvp ...` saves edits to a path both containers see. Option 1 doubles the write path and adds a divergence-on-failure risk where one save succeeds and the other doesn't.
- **No content drift.** With option 3, jdtls's view comes only from LSP notifications, so any change to `build.gradle`, `vendordeps/`, or non-`Robot.java` files (currently out of scope, but cheap to enable later) would not be visible to jdtls without extra plumbing.
- **First-mount auto-population works for free.** Docker initializes an empty named volume from the contents at the mount path on first attach. Both images bake `/workspace/project`, so whichever container starts first seeds the volume. No init container, no entrypoint script.
- **The volume survives container replacement.** When `dev:mvp` rebuilds an image and replaces a container, the volume is intentionally not deleted, so user edits made through the editor persist across image changes.

## Consequences

- The image contents at `/workspace/project` are *only* used to seed an empty volume. Once the volume has data, image rebuilds do not refresh `/workspace/project` for existing volumes. Resetting to a baked-fresh project is now `docker volume rm frc-project` rather than `docker rm` of the container. Documented in `README.md`.
- Both images still bake their own copy of the project so they remain individually runnable for sanity checks (e.g., the standalone `docker run --rm frc-sim:mvp` flow used to verify Task 1).
- Adding a third consumer of the project tree later (e.g., a future router or formatter container) is a one-line change: mount the same volume.

## Implementation pointers

- `scripts/dev-mvp.ts` — `ensureProjectVolume()` creates the volume idempotently before either container starts. The container `run` args include `-v frc-project:/workspace/project`.
- `SIM_VOLUME` env var (default `frc-project`) overrides the volume name. The sim, LSP, and dev orchestrator all honor it.
