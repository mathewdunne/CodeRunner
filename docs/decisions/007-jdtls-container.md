# 007 — jdtls in a sidecar container

**Status:** Implemented (Post-MVP M2)
**Date:** 2026-05-01

## Context

Post-MVP M2 adds Eclipse JDT Language Server (jdtls) so the Monaco editor can offer autocomplete, hover, and inline diagnostics for `Robot.java` against the WPILib classpath. jdtls is a 250 MB tarball plus a 1–2 GB JVM heap during operation, with its own Gradle invocation for project import. It does not belong in the sim container — running both alongside each other under a 2 GB cap is unworkable, and the sim already has a single-process responsibility (run `simulateJava` and expose NT4).

## Decisions

### Independent image, not `FROM frc-sim:mvp`

The two reasonable bases were:

1. `FROM frc-sim:mvp` — inherit the WPILib-primed Gradle cache and the project tree for free. Smaller LSP-specific Dockerfile.
2. Independent base — fully self-contained. Re-prime gradle in this image's build.

We picked option 2. Reasons:

- The two images have different lifecycles. The LSP image will track jdtls upstream releases; the sim image tracks WPILib seasons. Coupling them with `FROM` adds an implicit ordering constraint where rebuilding the sim invalidates the LSP image's layer cache for no useful reason.
- Build-time cost of re-priming gradle is ~2 minutes once, weighed against avoiding the dependency-direction smell. Acceptable.
- The image-layer storage cost of duplicating ~700 MB of WPILib jars is negligible on the dev machine and has no runtime impact.

### Dual JDK: JDK 21 default, JDK 17 staged for the Gradle prime

jdtls 1.58.0 requires JavaSE 21 — the OSGi bundles declare `(osgi.ee=JavaSE)(version=21)` and refuse to resolve under JDK 17. WPILib 2026's `build.gradle`, on the other hand, pins `sourceCompatibility/targetCompatibility = JavaVersion.VERSION_17` and runs against JDK 17 in the sim container.

We satisfy both with a multi-stage Dockerfile:

```Dockerfile
FROM eclipse-temurin:17-jdk-jammy AS jdk17
FROM eclipse-temurin:21-jdk-jammy
COPY --from=jdk17 /opt/java/openjdk /opt/jdk17
```

Default `java` on PATH is JDK 21 (used by jdtls). The Gradle prime step is invoked with `JAVA_HOME=/opt/jdk17 PATH=/opt/jdk17/bin:$PATH` so `./gradlew` runs under JDK 17 and matches what the sim container does. The non-default JDK 17 directory is `/opt/jdk17` to avoid colliding with the base image's `/opt/java/openjdk`.

Bumping the LSP image to a single JDK 21 base would probably also work — Gradle should translate VERSION_17 source/target via `--release 17` — but we don't want to discover a GradleRIO/JDK 21 incompatibility at first run. Two JDKs add ~300 MB to the image; image size isn't a constraint here.

### Pinned jdtls release

`ARG JDTLS_VERSION=1.58.0`, `ARG JDTLS_BUILD=202604151538`, with `ARG JDTLS_SHA256` verified against the `.sha256` file Eclipse publishes alongside each tarball at `https://download.eclipse.org/jdtls/milestones/<version>/`.

The `JDTLS_BUILD` timestamp in the filename (`jdt-language-server-1.58.0-202604151538.tar.gz`) is part of every published artifact — Eclipse does not republish a bare `<version>.tar.gz`. To bump the version, update all three ARGs together. The build verifies the SHA so a partial bump fails loudly rather than silently downloading a different artifact.

### `entrypoint.sh` is `sleep infinity`, not jdtls

The container is a long-lived "jdtls launchpad". The backend opens one fresh jdtls process per browser `/lsp` WebSocket via `docker exec -i frc-lsp-mvp sh -lc <jdtls cmd>`. When the WebSocket closes, the backend kills the process; the container survives.

This mirrors the pattern the sim container already uses (decision 004): the container itself is a stable shell that the host execs into to do work. Benefits:

- Per-session jdtls state (workspace data, in-memory document) is isolated to one process. A bad LSP request from one client cannot poison another client's session — though for the single-user MVP, this is theoretical.
- Cleanup on socket close is just process kill, not container restart.
- One jdtls process per WS keeps the backend code straightforward — no reference counting, no idle-eviction logic.

The trade-off is JVM cold start on every reconnect (~10–30s on first connect after container start; ~5s warm because the OS file cache holds jdtls's classes). Acceptable for MVP. If reconnect latency becomes a UX problem later, the next step is reusing one jdtls process across sequential WS connections — the protocol allows multiplexing but the framing in `apps/server/src/main.ts` would need extending.

### No jdtls workspace pre-warm during image build

The plan considered driving jdtls from a build-time script to pre-populate `.metadata`, the project's classpath cache, and the index. We skipped this:

- Driving jdtls over stdio in a `RUN` step is fiddly (requires spawning a Node helper, sending Content-Length-prefixed JSON-RPC, waiting for `language/status` "Ready", sending `shutdown`/`exit`).
- Build-time pre-warm only saves ~10 seconds of first-connect work in exchange for ~100 lines of Bash/Node + a maintenance burden when jdtls's startup behavior changes.
- The MVP "boring obvious" principle wins. We prime gradle (the slow part), and accept a longer first-connect.

If first-connect ever becomes painful in user testing, the cheaper next step is to have `dev:mvp` open a throwaway `/lsp` connection at startup so the JVM is warm by the time the user opens the page.

### Memory cap 4 GB

jdtls runs with `-Xmx1500m`, which under a steady-state workspace would fit comfortably in 2 GB. But the cold-start path — Buildship importing the Gradle project, resolving WPILib's classpath, building the JDT semantic index — combines JVM heap, JVM Metaspace and code cache, off-heap NIO buffers, and Buildship's own native classpath cache. Together these blow past 2 GB during the first `/lsp` connection and trigger the cgroup OOM killer mid-import.

Symptom when capped at 2 GB: jdtls exits silently around the 60s mark, the browser status pill never reaches `idle`, and `docker stats` showed memory at 1.99 GB / 2 GB right before death. With `--memory=4g` the cold-start path peaks around ~3 GB and settles to ~1.6 GB once the workspace is warm.

The sim container stays at 2 GB because its actual workload (`./gradlew simulateJava`) is much leaner. Adjusting both the same would have been simpler but wastes the host's RAM on the sim side.

## Verification

Verified during implementation:

- `docker build -f containers/lsp/Dockerfile -t frc-lsp:mvp .` completes in ~3 min on a warm cache.
- `docker run --rm frc-lsp:mvp ls /opt/jdtls/plugins | grep equinox.launcher` shows the launcher jar.
- `docker exec frc-lsp-mvp java -version` prints `17.x`.

Manual end-to-end verification still requires Docker available to the caller.
