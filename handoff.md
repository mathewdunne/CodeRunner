# Handoff: Shared Gradle Cache for `coderunner-workspace`

## Goal

Reduce per-workspace `.gradle` footprint by deduplicating immutable Gradle artifacts across workspaces, without sharing writable workspace state.

## Measured baseline

Sampled `data/users/ws_d599638d489e7415f4f8aeeacf42961f`:

```
5.3G  total workspace
4.4G  home/
  3.2G  home/.gradle/
    2.1G  caches/8.11/transforms     ← biggest, not in original plan
    795M  caches/modules-2
    146M  wrapper
    146M  permwrapper                  (investigate: looks duplicative)
     34M  daemon
    8.1M  caches/jars-9
639M  project/build                  (per-workspace, not shareable)
171M  backups
```

## Findings

### modules-2 + wrapper/dists (~940 MB/workspace)

- Sharable read-only via Gradle's first-class `GRADLE_RO_DEP_CACHE`.
- Gradle resolves from the RO dir first, falls back to writable `GRADLE_USER_HOME`, then network. No writes go to the RO location (no journal, no GC).
- `wrapper/dists` can be a separate read-only bind mount at `$GRADLE_USER_HOME/wrapper/dists`. Wrapper extraction has its own lockfile and tolerates a pre-populated dir.
- **Do not** include `caches/jars-9` — it's a transformation cache that Gradle writes to during reads, and `GRADLE_RO_DEP_CACHE` does not cover it. 8 MB anyway.

### caches/8.11/transforms (~2.1 GB/workspace)

318 hash-named entries. By bulk:

| Transform | Size | Notes |
|---|---|---|
| `wpimath-cpp` | 1.17 GB | unpacked native zip |
| `wpiutil-cpp`, `halsim_gui`, `ntcore-cpp`, `opencv-cpp`, `apriltag-cpp`, `hal-cpp`, `cscore-cpp`, `wpinet-cpp` | ~940 MB combined | unpacked natives |
| vendor sim libs | ~50 MB | unpacked natives |
| `instrumented` / `merge` / `analysis` | ~65 MB | Gradle classpath instrumentation |

~95% is "unzip native library artifact" — deterministic transform from input zip to output dir.

**Sharable in principle:**
- Entries are content-addressed by input artifact + transform parameters, not by project path.
- Greped metadata/results files for `coderunner`, workspace ID, `/config`, `/data/users` — no workspace-local paths embedded.
- Same WPILib version + same Gradle version → same hashes across workspaces.

**Mechanism is harder than modules-2:**
- No `GRADLE_RO_DEP_CACHE` equivalent for transforms in Gradle 8.11.
- Gradle treats transforms as writable per-user state (creates new entries, takes locks, runs LRU cleanup).
- Cannot just bind-mount read-only.

## Recommended approach

Stack two layers:

### Layer 1: `GRADLE_RO_DEP_CACHE` for modules-2 + wrapper

- Shared host path: `/var/cache/coderunner/gradle-ro/`
- Container path: `/shared/gradle-ro/` (read-only bind mount)
- Set `GRADLE_RO_DEP_CACHE=/shared/gradle-ro` in container env.
- Separate read-only bind mount for `wrapper/dists`.
- Seed contents during image build by running a template build, then extract `modules-2` + `wrapper/dists` into the shared dir.
- Refresh story: build a new versioned dir, atomically swap a symlink. Or just rebuild on image bumps and accept it.

### Layer 2: Hard-link seed for transforms

- Bake a populated transforms dir into the image at `/usr/local/share/coderunner/gradle-seed/transforms/<gradle-version>/`.
- On container init (in `init-frc-setup`), `cp -al` from seed into `$GRADLE_USER_HOME/caches/<gradle-version>/transforms/`.
- Each workspace gets its own directory view; file *contents* share inodes on the host data volume.
- Gradle can add/remove entries normally — files-it-doesn't-touch stay hard-linked, files-it-evicts just drop the workspace's link (seed inode stays alive).

**Why hard-linking is safe here:**
- Gradle's transform model is strictly create-new-hash, never mutate-in-place. Confirmed by entry structure: hash dirs are immutable once written.
- If hashes ever did need to mutate, hard links wouldn't corrupt the seed (write would happen via temp + rename, breaking the link cleanly).
- Page-cache dedup is a real RAM win — same inode = same cached pages.

**Constraint:** seed dir must be on the same filesystem as `/data/users/`. Trivially arranged.

### Combined impact

| Layer | Per-workspace savings | Mechanism |
|---|---|---|
| `GRADLE_RO_DEP_CACHE` (modules-2 + wrapper) | ~940 MB | bind mount, RO |
| Hard-link seed (transforms) | ~2 GB (disk + page cache) | `cp -al` on init |
| **Total** | **~2.9 GB** of the 3.2 GB `.gradle` tree |

Per-workspace `.gradle` should then only grow with daemon state, journals, fileHashes, and any new modules/transforms the user introduces beyond the seed.

## Constraints from the original plan (still apply)

- Do **not** share the full writable `.gradle` tree.
- Keep per-workspace `/config` and `HOME/.gradle` intact as the live Gradle home.
- Do not share `daemon/`, `journal-*`, `notifications/`, `fileHashes`.
- Preserve current bind-mount contract for `data/users/<workspaceId>/home` and `.../project`.

## Files to touch

- `apps/control/src/containers/local-docker-runtime-provider.ts` — add bind mounts (shared RO cache, wrapper dists), set env vars.
- `containers/code/Dockerfile` — bake seed transforms during image build; populate `/usr/local/share/coderunner/gradle-seed/`.
- `containers/code/root/etc/s6-overlay/s6-rc.d/init-frc-setup/run` — `cp -al` seed transforms into `$GRADLE_USER_HOME/caches/<ver>/transforms/` on init.
- `containers/code/run-sim.sh` / `start-sim.sh` — ensure `GRADLE_RO_DEP_CACHE` is set in build environment.
- `containers/code/README.md`, `deploy/README.md` — document the shared cache layout and refresh procedure.
- New decision log under `docs/decisions/` covering the split RO-cache + hard-link-seed approach.

## Things to verify before committing

1. **Transform hash stability.** Build the template project in two fresh workspaces, diff the transform hash sets. They should be identical. If not, there's a hidden input we missed.
2. **Gradle version pinning.** Transforms dir is per-Gradle-version (`caches/8.11/transforms`, `caches/8.12/transforms`, …). Image build must populate the matching version. If WPILib bumps Gradle, the seed needs a rebuild.
3. **Hard-link semantics on the deployed filesystem.** Confirm the data volume isn't doing anything weird (e.g., ZFS with dedup already on; tmpfs; copy-on-write that wouldn't honor hard links the way ext4 does).
4. **`permwrapper` (146 MB).** Investigate whether it's a duplicate of `wrapper` or required by FRC tooling. Free ~146 MB/workspace if removable.
5. **`project/build` (639 MB).** Not shareable, but consider excluding from backups — it's pure rebuild artifact.

## Verification plan

- Fresh workspace: confirm Gradle build completes using shared modules-2 + transforms seed (no network re-downloads for pinned deps; transforms reused, not regenerated).
- Existing workspace: confirm reuse of shared cache while still writing local `.gradle` state (daemon, journal, fileHashes).
- Per-workspace `.gradle` measured after a build should be ≪ 3.2 GB (target: well under 1 GB, mostly daemon + per-project metadata).
- Two concurrent builds in different workspaces: no lock contention, no GC interfering between them.

## Out of scope

- Sharing `caches/jars-9` (8 MB, not worth the risk).
- Touching `project/build` layout.
- Backup/restore policy changes (separate concern, but `project/build` exclusion is an easy follow-up).
