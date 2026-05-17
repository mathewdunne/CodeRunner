# 024 — Bound Per-Workspace Container Memory

## Status

Accepted.

## Context

A live localhost production-style workspace container running one browser client and an active robot simulation was measured on 2026-05-17. Docker reported about 2.2 GiB active memory with a cgroup high-water mark around 3.2 GiB.

The largest private/proportional memory users were:

| Process group | Approx. PSS |
|---|---:|
| VS Code Gradle daemon from the Gradle Build Server path | 491 MiB |
| Simulation Gradle daemon | 525 MiB |
| Robot simulation JVM | 394 MiB |
| JDT LS | 332 MiB |
| VS Code Gradle server | 231 MiB |
| openvscode-server Node processes | 258 MiB |

The student robot heap itself was small: `jcmd GC.heap_info` showed roughly 37 MiB used and a 100 MiB committed heap. The high container usage was mostly duplicated Gradle infrastructure, JVM default envelopes, and editor/language-server services.

## Decision

Keep the merged openvscode-server container model, but seed classroom-density defaults:

- Disable `java.gradle.buildServer.enabled` and `gradle.autoDetect` by default. JDT LS still imports Gradle projects; the separate VS Code Gradle Build Server path is not required for the browser training flow.
- Lower JDT LS defaults from WPILib's `-Xmx8G` setting to `-Xmx512m`.
- Seed Gradle defaults with `-Xms64m -Xmx384m`, `--no-watch-fs`, `--max-workers=2`, `org.gradle.daemon=false`, and `org.gradle.parallel=false`.
- Run `start-sim.sh` with the same bounded Gradle daemon settings, regardless of whether an imported project contains `gradle.properties`.
- Cap the robot simulation `JavaExec` heap at `-Xmx256m` by default.

All defaults are environment-overridable from the container launch path.

## Consequences

The biggest expected win is avoiding the Gradle Build Server server/daemon pair, which accounted for roughly 700 MiB PSS in the measured container. Bounded Gradle and JDT LS settings reduce peak risk and should lower committed memory after restart.

Gradle task discovery in the VS Code Gradle view is intentionally de-emphasized. The app's Run button and WPILib/JDT project import remain the supported path.
