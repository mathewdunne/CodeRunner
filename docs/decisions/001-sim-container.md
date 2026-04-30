# 001 — Sim container architecture

**Status:** Implemented (Task 1 of MVP)
**Date:** 2026-04-30

## Context

Task 1 of `Project-MVP.md` requires a Docker image that builds and runs a headless WPILib 2026 robot project, exposing NT4 on port 5810, runnable under a 2 GB memory cap. This will be the long-lived container the backend exec's into starting in Task 4.

## Decisions

### Single-stage Dockerfile

Multi-stage builds usually shrink image size by leaving build tooling behind, but here we *want* `~/.gradle/caches` baked into the final image so container startup doesn't re-download WPILib jars and natives every run. Copying the cache between stages defeats the point. Single stage, accept the ~1 GB image.

### Headless via omission, not flag

GradleRIO 2026 makes SimGUI (`halsim_gui`) and the DriverStation sim (`halsim_ds_socket`) opt-in via `wpi.sim.addGui()` and `wpi.sim.addDriverstation()` in `build.gradle`. The stock template enables both with `defaultEnabled = true`. We delete those two lines. No `-PsimExtensions=` flag, no extension-clearing hack — just don't add them.

`./gradlew simulateJava` then runs purely in the JVM with NT4Server (which `RobotBase` starts automatically, bound to `0.0.0.0:5810`). No X server, no `libGL.so.1`, no DISPLAY env var needed.

### `eclipse-temurin:17-jdk-jammy` base image

- WPILib 2026 targets JDK 17. JRE-only would break Gradle's annotation processing and source compilation during image build.
- Alpine (`-alpine` variant) is musl-based; WPILib native libs are glibc-built and would fail to load.
- `gradle:8-jdk17` ships a system Gradle we'd ignore (we use the wrapper for version pinning), pure bloat.
- `jammy` (Ubuntu 22.04) over `noble` (24.04) for slightly smaller image; either works.

### Gradle daemon disabled

`org.gradle.daemon=false` in `gradle.properties` plus `--no-daemon` on every gradle invocation. Daemons would survive past container start as orphaned processes; running gradle without one is slightly slower but trivial in a container's lifetime.

### Versions pinned

- GradleRIO `2026.1.1` (matches the version installed locally at `C:\Users\Public\wpilib\2026`, confirmed against `vsCodeExtensions/vscode-wpilib-2026.1.1.vsix` and `maven/edu/wpi/first/GradleRIO/2026.1.1`).
- Gradle `8.11` (matches the wrapper that ships with the WPILib install).

### Project skeleton hand-rolled, not generated

The WPILib `wpilib` CLI tool is a desktop GUI / VS Code extension, not a CLI we want as a container build dep. The skeleton is small (~8 files); we hand-rolled it from `C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\java\build.gradle` and `.../gradle/shared/`. Gradle wrapper jar + `gradlew` script are copied verbatim from the install since those are binary/script artifacts.

### Online frcmaven repo added to `settings.gradle`

The stock template's `settings.gradle` only references `frcHome/maven` (the local install). Inside Docker that path doesn't exist, so we add `https://frcmaven.wpi.edu/artifactory/release/` as a `pluginManagement` repo and keep the local-frcHome lookup wrapped in an `if (frcHomeMaven.exists())` guard for non-container dev convenience.

### Telemetry: `StructPublisher<Pose2d>`, not raw `double[3]`

AdvantageScope auto-decodes `Pose2d` struct topics for the 2D Field tab. Publishing the raw `double[3]` array would also work but loses the type info AS uses for visualization defaults.

## Image size expectation

After `./gradlew build` primes the cache and we delete `project/build` and `project/.gradle`, the image lands around 1.0–1.4 GB. Most of that is Gradle distribution (~140 MB extracted) plus WPILib jars + native libs in `~/.gradle/caches/modules-2/files-2.1/`. Acceptable for MVP. Compresses to 400–600 MB on registry push if we ever push it.

## Out of scope (deliberately)

- Hot-reload of robot code. Task 4 will restart the sim via `docker exec` running gradle.
- VOLUME directive on `/workspace/project`. Task 4 writes files via exec, not bind mount.
- `docker compose` orchestration. Single-image MVP for now; compose comes after Task 4.

## Issues encountered during implementation

### 1. Missing `WPILibNewCommands.json` vendor dep

First build failed with `package edu.wpi.first.wpilibj2.command does not exist`. The new commands library (`edu.wpi.first.wpilibj2.command.*`) is **not** included in `wpi.java.deps.wpilib()` — it ships as a vendor dep (`WPILibNewCommands.json`), even though it's a first-party WPILib library. Fix: copy `C:\Users\Public\wpilib\2026\vendordeps\WPILibNewCommands.json` into `project/vendordeps/`. GradleRIO auto-loads any JSON in that directory and resolves it via `wpi.java.vendor.java()`.

If we add more vendor libs later (REVLib, PathPlanner, Phoenix, etc.), drop their JSON files in `project/vendordeps/` the same way.

### 2. Dockerfile `|| true` swallowed gradle build failure

Original `RUN` was a chain `cmd1 && cmd2 && cmd3 || true`. Bash precedence treats this as `(cmd1 && cmd2 && cmd3) || true`, so any failure in the chain returns 0 and the Docker layer "succeeds" with a broken project inside. The compile error from issue #1 was masked this way — `docker build` reported success and produced an image, but the image didn't actually have a built robot.

Fix: split into discrete `RUN` lines. The gradle build is its own `RUN` so its exit code propagates. The `--stop` cleanup uses `;` (sequential) instead of `&&` since we don't care if there's no daemon to stop.

Lesson: don't mix `|| true` with `&&` chains. Either give each command its own `RUN` or use explicit `set -e` inside a `RUN bash -c`.

### 3. Image size came in at 2.25 GB, not the 1.0–1.4 GB plan estimate

Larger than predicted. Plan estimate didn't account for `nativeDebug` and `nativeRelease` configurations both downloading platform JNI libs (`linuxx86-64`), nor for the size of `roborioDebug` / `roborioRelease` which we don't strictly need (we never deploy to a roboRIO from this container).

Acceptable for MVP per the "boring obvious option" principle — the image runs fine under `--memory=2g` and starts the sim in ~30 s. Optimization opportunities for later if image size becomes a concern:

- Strip `roborioDebug` / `roborioRelease` configurations from `build.gradle` (no roboRIO deploy from container).
- Strip `nativeDebug` / `simulationDebug` (we only need release for the sim).
- After cache prime, prune `~/.gradle/caches/modules-2/metadata-*` and `~/.gradle/caches/build-cache-1`.

None of these matter for MVP; just noting the gap from estimate.

### 4. Wrapper-zip warning is cosmetic

GradleRIO 2026 prints `Warning! Your wrapper zip / dist store is set to wrapper/dists! This can cause issues when going to competition...`. We're not deploying to a roboRIO at competition, so it's irrelevant. Suppress later via `-Pskip-inspector-wrapper` if it gets noisy in the console panel during Task 4.

## Verification results

Run on 2026-04-30 against `frc-sim:mvp` image `d5de445029c1`:

- `docker build` first run: ~50 s on a warm BuildKit cache (apt + base layer cached). Cold: would be ~2 min for base pull + 45 s for gradle prime. Comfortably under the 10-min DoD budget.
- Image size: **2.25 GB** (vs. 10-min build budget; size is not in the DoD but worth noting).
- Container starts the sim within ~30 s and prints `NT: Listening on NT3 port 1735, NT4 port 5810`.
- `HAL Extensions: No extensions found` confirms truly headless — no SimGUI, no DriverStation extension.
- `docker stats`: 1% CPU, 674 MiB RSS (within `--memory=2g` cap).
- TCP 5810 reachable from Windows host (`Test-NetConnection localhost 5810` → True).
- `docker stop frc-sim-test`: returns in 1 s; JVM is PID 1, SIGTERM propagates.
- Visual verification of counter + pose in desktop AdvantageScope: **deferred to user** (DoD step 3 — connect AS to localhost:5810 and confirm counter increment + pose circle).
