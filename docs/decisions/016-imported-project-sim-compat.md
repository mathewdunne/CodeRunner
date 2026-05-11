# 016 — Imported project simulation compatibility

**Status:** Implemented  
**Date:** 2026-05-11

## Context

The simulator was built and tested with the bundled template project (`templates/wpilib-java-command/`), which is configured for headless simulation: no `wpi.sim.addGui()`, no `wpi.sim.addDriverstation()`, with `wpi.sim.addWebsocketsServer()` enabled. When the project import feature was used with a real FRC team project for the first time, two issues surfaced:

1. **Sim GUI loading.** The imported project's `build.gradle` called `wpi.sim.addGui()` and `wpi.sim.addDriverstation()`, which loaded `halsim_gui`. This native extension attempted to initialize GLFW/X11, which is unavailable in the headless Docker container, producing noisy errors. Meanwhile, the HALSim WebSocket server (needed for the web Driver Station UI) was missing.

2. **GLIBCXX_3.4.32 not found.** Third-party vendor JNI libraries (PhotonLib in this case) were compiled with GCC 13+ and required `GLIBCXX_3.4.32`. The container's base image (`gitpod/openvscode-server:1.105.1`, Ubuntu 22.04 Jammy) shipped `libstdc++6 12.3.0` which only provides up to `GLIBCXX_3.4.30`.

## Decisions

### Gradle init script for headless simulation override

A Gradle init script (`containers/code/sim-headless.init.gradle`) is applied via `--init-script` in `start-sim.sh`. In an `afterEvaluate` hook it:

- Removes `halsim_gui` and `halsim_ds_socket` dependencies from the `simulationDebug` and `simulationRelease` configurations.
- Adds `wpi.sim.addWebsocketsServer().defaultEnabled = true` if the websocket server is not already present.

**Why init script over build.gradle patching:**

- Works for any project (imported, manually created, modified after import) without touching user files.
- Handles both Groovy and Kotlin DSL build scripts since it operates at the Gradle API level.
- Gradle's official mechanism for environment-level build overrides.
- Non-destructive: users see their original `build.gradle` in the editor.

The template project already has the correct headless config, so the init script is a no-op for it.

### Upgrade libstdc++6 via Ubuntu toolchain PPA

The Dockerfile installs `software-properties-common`, adds `ppa:ubuntu-toolchain-r/test`, and upgrades `libstdc++6` to a version that provides `GLIBCXX_3.4.32+`. This is the standard way to get newer GCC runtime libraries on Ubuntu LTS without upgrading the entire OS.

**Alternatives considered:**

- **Switch base to linuxserver/openvscode-server (Ubuntu 24.04):** solves GLIBCXX natively and provides a newer VS Code. Implemented in Decision 017.
- **Download a specific `.deb` from Ubuntu noble**: fragile, pins to a specific package version.

## Verification

- Template project: init script is a no-op (no GUI/DS deps to remove, WS server already present). Sim starts as before.
- Imported project with `wpi.sim.addGui()`: init script removes GUI dep, adds WS server. Sim starts headless with HALSim WebSocket server. `HAL Extensions: No extensions found` or only `halsim_ws_server` in logs.
- PhotonLib JNI: `libphotontargetingJNI.so` loads successfully with upgraded libstdc++6.
