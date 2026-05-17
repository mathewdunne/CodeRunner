# 025 — Detach the Simulation JVM from Gradle

## Status

Accepted.

## Context

After [decision 024](024-container-memory-budget.md) bounded the JVM envelopes inside the per-workspace container, a live measurement on 2026-05-17 showed 1.86 GiB resident with one active simulation. Of that, ~574 MiB belonged to two Gradle processes that exist solely to keep the simulation alive:

| PID | Process | RSS |
|---|---|---:|
| 555 | `gradlew --no-daemon … simulateJava` (client wrapper) | 119 MiB |
| 614 | `org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.11` | 456 MiB |

`simulateJava` is a `JavaExec` task, so even with `--no-daemon` Gradle 8 forks a single-use worker JVM and the wrapper blocks on it for the entire simulation lifetime. The actual robot JVM (PID 865, `java -jar build/libs/project.jar`) is already a self-contained fat JAR with WPILib and vendor classes bundled; Gradle has nothing left to do once it has spawned the JVM.

## Decision

Replace the long-lived `simulateJava` invocation with a two-phase flow inside `start-sim.sh`:

1. **Build phase.** Run `./gradlew simulateExternalJavaRelease` (a `JavaExternalSimulationTask` provided by GradleRIO). It builds the project JAR, extracts JNI natives into `build/jni/release`, writes a descriptor at `build/sim/release_java.json`, and exits. Gradle is no longer in memory.
2. **Run phase.** Parse the descriptor, filter the HALSim extensions to the subset whose libraries actually exist on disk (the init script removes `halsim_gui` and `halsim_ds_socket` from the `simulationRelease` config), set `LD_LIBRARY_PATH` / `HALSIM_EXTENSIONS` / `-Djava.library.path`, then `exec java -jar build/libs/*.jar`. Because the shell `exec`s into the JVM, the original subshell PID survives, so the value written to `sim.pid` is valid for the entire simulation.

The work is split: `start-sim.sh` stays a thin launcher (validate the mount, `setsid` the runner, write `sim.pid`); `run-sim.sh` owns the two phases. The Gradle invocation keeps the same bounded JVM args, `--no-daemon`, `--no-watch-fs`, `--max-workers=2`, and the headless init script from decision 024.

`stop-sim.sh`'s orphan matcher is broadened from `*simulateJava*` to `*simulate*` so it still catches the wrapper during the brief build window for any sim-related task name.

## Consequences

The Gradle wrapper and its worker JVM exist only while the build runs (typically 5–30 s on an incremental rebuild). During the long-running simulation, neither is present, so per-workspace memory drops by ~574 MiB at steady state on the measured project. The JVM PID — and therefore `tail --pid` lifecycle in the run-queue wrapper — keeps the same semantics as before.

Trade-offs:

- A fresh `BUILD FAILED` path is added: if the descriptor file is missing or no JAR exists under `build/libs`, `run-sim.sh` writes `BUILD FAILED: …` to the log and exits. The run-queue wrapper already greps for `BUILD FAILED` in the log, so this slots in cleanly.
- The bounded-heap `JavaExec` modifier in `sim-headless.init.gradle` no longer applies to our run path, since we never call `simulateJava`. It is retained as defense in depth for users who run `simulateJava` directly from the IDE. The JVM args for our path are passed by `run-sim.sh` from the `ROBOT_SIM_JVMARGS` env var with the same defaults.
- `simulateExternalJavaRelease`'s descriptor lists every HALSim extension that was ever requested, not just the ones whose native libs were extracted. `run-sim.sh` filters by file existence, so the init script's `halsim_gui`/`halsim_ds_socket` removal continues to take effect without needing matching changes in the descriptor.
