# 026 — Gradle Cache Deduplication via Image Seed

## Status

Partially accepted. Changes 2 and 3 are in. Change 1 (host-side hard-link seed) was attempted and rolled back — see below.

## Context

Each workspace's `data/users/<id>/home/` directory is bind-mounted into its container as `~/.gradle`. On first container start, `init-frc-setup` copies the Gradle cache baked into the image (`/opt/frc-gradle-cache/`) into that directory. Measurement on a workspace running a real student project (large, with multiple FRC vendor libraries) showed:

```
3.6 GB  data/users/<id>/home/.gradle/
  2.1 GB  caches/8.11/transforms/    ← unpacked native vendor libraries
  760 MB  caches/modules-2/           ← downloaded JARs and metadata
  146 MB  wrapper/dists/              ← extracted Gradle 8.11
  146 MB  permwrapper/dists/          ← identical duplicate of wrapper/dists
```

With 10 workspaces, the `.gradle/` trees alone account for ~36 GB of host disk. All of it is regenerable from the network, and the vast majority (~3 GB/workspace) is identical across all workspaces running the same WPILib season.

Two specific problems were identified:

**Hash stability.** Before committing to a shared seed, transform hash stability was verified across two live workspaces running the same imported project. 286 of 288 transform entries were byte-for-byte identical. The 2 divergent entries (`halsim_ds_socket`, `halsim_gui`) were optional project-specific halsim plugins absent in one workspace — expected variance. No workspace-local paths appeared in any `metadata.bin` or `results.bin` file. The hash scheme is content-addressed on input artifact + transform parameters only.

**`permwrapper` duplication.** WPILib's published project template sets `distributionPath=permwrapper/dists` and `zipStorePath=permwrapper/dists` in `gradle-wrapper.properties`. The CodeRunner template uses the standard `wrapper/dists`. When a student imports a WPILib project, Gradle wrapper extracts a second copy of the same gradle-8.11 zip into `permwrapper/dists/` — byte-identical to `wrapper/dists/`, 146 MB wasted per workspace.

**Narrow seed.** The image seed was built from `templates/wpilib-java-command` (GradleRIO 2026.1.1, WPILib only). Student projects with vendor libraries (Phoenix6, REVLib, AdvantageKit, etc.) generated ~162 additional transforms (~700 MB) from scratch on first build. These were downloaded from the network, not from the seed.

## Decision

Three changes were attempted. Two shipped; one was rolled back.

---

### Change 2: Eliminate `permwrapper` duplication (shipped)

A `permwrapper -> wrapper` relative symlink is added to `/opt/frc-gradle-cache/` during the Dockerfile build (`ln -s wrapper /opt/frc-gradle-cache/permwrapper`). When init seeds the workspace, `~/.gradle/permwrapper` becomes a symlink to `~/.gradle/wrapper`. Gradle wrapper follows it transparently for projects with `distributionPath=permwrapper/dists`. Saves 146 MB per workspace with zero risk.

---

### Change 3: Expand seed to cover common vendor lib transforms (shipped)

A new project (`containers/code/gradle-seed-project/`) is added with `build.gradle` identical to the template but declaring all 9 common FRC vendor libraries in `vendordeps/`. The Dockerfile runs a second `./gradlew build` pass with this project (reusing the template's gradlew and src, sharing the same `GRADLE_USER_HOME=/config/.gradle`). The accumulated cache — including ~162 additional transforms for Phoenix6, REVLib, AdvantageKit, photonlib, and others — is then captured into `/opt/frc-gradle-cache/`.

The template's GradleRIO version is also bumped from 2026.1.1 to 2026.2.1 to align with the seed project so transforms from template-based new projects match the seed.

**Customizing the seed:** The set of pre-baked vendor libraries is controlled by the JSON files in `containers/code/gradle-seed-project/vendordeps/`. Add or remove files there and rebuild the image. When updating WPILib/GradleRIO versions, update both `containers/code/gradle-seed-project/build.gradle` and `templates/wpilib-java-command/build.gradle` together.

**Currently included vendor libraries:**

| Library | Version |
|---|---|
| AdvantageKit | 26.0.1 |
| PathplannerLib | 2026.1.2 |
| Phoenix6 (CTRE) | 26.1.2 |
| REVLib | 2026.0.5 |
| Studica | 2026.0.0 |
| URCL | 2026.0.0 |
| maple-sim | 0.4.0-beta |
| photonlib | v2026.3.2 |
| YAMS | 2026.3.11 |

---

### Change 1: Host-side hard-link seed (attempted, rolled back)

**What was tried:** Extract `/opt/frc-gradle-cache/` from the image to `data/gradle-seed/` on the host once per image version. Before starting each new container, the control plane would `cp -al data/gradle-seed/. data/users/<id>/home/.gradle/` — hard-linking the seed files so all workspace `.gradle/` directories share inodes with the seed. Both paths live on the same ext4 volume so `link()` works without EXDEV errors.

A `scripts/populate-gradle-seed.ts` script extracted the seed via `docker run --mount type=bind,src=$seedDir,dst=/out ... sh -c 'find /out -mindepth 1 -delete; cp -a /opt/frc-gradle-cache/. /out/'`. All writes ran inside the container (as root) to avoid host-side EACCES on root-owned files from prior runs. The control plane's `createCodeContainer()` called `seedGradleCache()` before container start to hard-link the seed, falling back to `cp -a` on failure.

**Why it was rolled back:**

1. **Savings smaller than expected.** After implementing all three changes, per-workspace size dropped from ~3.6 GB to ~3.2 GB — mostly from Changes 2 and 3. Hard-link dedup does not reduce per-workspace `du` output (the same inodes appear full-size under each workspace subtree); savings only appear in aggregate host disk usage, which was harder to measure and validate.

2. **Silent fallback on hard-link failure.** `cp -al` failure was logged at debug level and fell back to `cp -a`, so production could silently regress to full copies. The service runs as `coderunner`; the seed is populated by `docker run` (root). On Linux hosts with `fs.protected_hardlinks=1`, hard-linking files owned by a different UID fails. This was a plausible production failure mode with no operator-visible signal.

3. **Non-atomic seed refresh.** The seed refresh (`find /out -mindepth 1 -delete` then `cp -a`) is destructive in place. A workspace created mid-refresh could pick up a partial cache and fail at Gradle runtime with opaque errors (e.g. `metadata.bin: No such file or directory`), which look like project-specific failures.

4. **FRC_DATA_DIR mismatch.** `populate-gradle-seed.ts` resolved the seed path relative to the repo root (`data/gradle-seed/`), but `LocalDockerRuntimeProvider` resolved it from `this.storage.config.dataDir` (which respects `FRC_DATA_DIR=/var/lib/coderunner/data` in production). The seed would be written to the wrong location and never consumed in production.

5. **Wrong image seeded on pull.** `docker:pull:workspace` pulls `ghcr.io/.../coderunner-workspace:latest` but `populate-gradle-seed.ts` inspected `CODE_IMAGE` defaulting to `coderunner-workspace` (unqualified local name). On a fresh machine this fails; on a machine with a stale local image it seeds the wrong version.

**If revisiting:** The hard-link approach is sound in principle but requires: (a) populating the seed as the `coderunner` user (not root) so `protected_hardlinks` doesn't block; (b) atomic seed refresh via a versioned temp dir + symlink swap; (c) resolving the seed path from `dataDir`, not the repo root; (d) passing the fully qualified image name through from the pull/build command; (e) accepting that this only benefits new workspaces (existing workspace homes already have `caches/` and skip seeding).

## Consequences

### Disk savings achieved (Changes 2 and 3 only)

| Change | Saving | Mechanism |
|---|---|---|
| permwrapper symlink | 146 MB/workspace | No second Gradle wrapper extraction |
| Richer image seed (vendor transforms pre-baked) | ~400 MB first-build download avoided | Pre-baked in image, copied on init |

Observed reduction: ~3.6 GB → ~3.2 GB per workspace after a full student project build with vendor libs.

### Image size

The image grows by the seed project's vendor lib artifacts (~700 MB of transforms + ~400 MB of modules-2 entries). Docker build time increases by the time needed to download and transform all vendor artifacts during the second build pass.

### Operational changes

- `containers/code/gradle-seed-project/vendordeps/` controls what vendor libs are pre-baked. Add/remove JSON files and rebuild.
- When WPILib releases a new GradleRIO version, update both `containers/code/gradle-seed-project/build.gradle` and `templates/wpilib-java-command/build.gradle` together so transform hashes align.

### What is not covered

- `caches/jars-9/` (8 MB, Gradle's classpath instrumentation cache) — Gradle writes to it during reads; not safe to share, not worth it for 8 MB.
- `project/build/` (639 MB, per-project build output) — not shareable; can be excluded from backups as a pure rebuild artifact.
- Workspaces with vendor library versions that differ from the seed versions generate their own transforms on first build, as before.
