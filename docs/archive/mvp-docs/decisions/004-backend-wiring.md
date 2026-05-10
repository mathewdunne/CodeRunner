# 004 - Backend wiring for save and run

**Status:** Implemented (Task 4 of MVP)
**Date:** 2026-05-01

## Context

Task 4 connects the browser shell to the baked WPILib project in the sim container: Monaco reads and writes `Robot.java`, Run builds the Java project, the sim restarts, and build/sim output streams into the browser console.

The MVP is still one hardcoded user and one hardcoded project. The author expects a later rewrite, so the implementation favors a small host-run service over a containerized control plane.

## Decisions

### Host backend plus Docker CLI

The backend lives in `apps/server/` as a strict TypeScript Fastify app. It shells out to the Docker CLI with fixed argument arrays instead of adding `dockerode` or a broader orchestration dependency. This matches the MVP scope: one named container, one file path, no dynamic scheduling.

The default container is `frc-sim-mvp`, configurable with `SIM_CONTAINER`. The Java source path is fixed at `/workspace/project/src/main/java/frc/robot/Robot.java`.

### Minimal endpoints and run protocol

The service exposes:

- `GET /file`: returns `Robot.java` as `text/plain`.
- `POST /file`: accepts a `text/plain` body and writes it through `docker exec -i`.
- `WS /run`: sends JSON text frames for status, log lines, exits, and errors.

No shared package was added. The frontend/server message shape is intentionally tiny and local to Task 4, so duplicating the union type is clearer than creating a shared workspace package before there is real shared domain code.

### Custom WebSocket sender, no new dependency

`@fastify/websocket` was not added because the current environment already has Fastify but does not have npm available on PATH for dependency installation. The `/run` socket is server-to-client text streaming only, so the backend implements the WebSocket handshake and unmasked text frames directly on Node's HTTP `upgrade` event. The browser does not send application messages.

This is deliberately narrow. If the protocol grows beyond log streaming, replace it with `@fastify/websocket` or another maintained WebSocket package.

### Replaceable sim process inside long-lived container

The original container entrypoint `exec`ed `./gradlew simulateJava`, making the sim process PID 1. Task 4 needs to stop and restart the sim without replacing the whole container, so the image now includes:

- `/usr/local/bin/start-sim.sh`: starts `./gradlew --no-daemon --console=plain simulateJava` in a new process group and writes `/workspace/sim.pid` plus `/workspace/sim.log`.
- `/usr/local/bin/stop-sim.sh`: terminates that process group and removes the pid file.
- `entrypoint.sh`: starts the initial sim, then tails `/workspace/sim.log` so `docker run` still shows sim output while the container stays alive.

`WS /run` stops the current sim, starts `./gradlew --no-daemon --console=plain simulateJava`, and follows container logs from the host with `docker logs --follow --since ...`. This keeps each Run to one Gradle invocation because `simulateJava` performs the required build work before launching the robot. A tiny watcher `docker exec` waits for the current sim PID to exit, so closing or replacing a browser run socket kills only host-side Docker CLI processes and does not leave in-container `tail --pid` processes behind.

The container entrypoint now runs under `tini`, because the backgrounded Gradle/Java sim process can become an orphan under PID 1 after restarts. Without an init/reaper, stopped sim PIDs can remain as zombies; `kill -0` still sees those PIDs, which caused every rebuild to wait for the 10 second hard-kill path. `stop-sim.sh` also treats zombie PIDs as stopped and sends termination to the process groups used by the saved Gradle wrapper process and its descendants.

`npm run dev:mvp` compares the existing `frc-sim-mvp` container image ID to the current `frc-sim:mvp` image ID. If the image was rebuilt, it replaces the old container so the dev stack does not silently keep running stale lifecycle scripts.

### One-command dev stack without Docker Compose

`scripts/dev-mvp.ts` implements the MVP's "equivalent single command": `npm run dev:mvp`.

It ensures `frc-sim-mvp` exists and is running from image `frc-sim:mvp`, then starts AS Lite, the backend, and Vite as host processes. The child processes launch the underlying Node CLIs directly (`tsx` for the TypeScript services and Vite's JS entrypoint for the web app) instead of spawning `npm run ...`; this avoids a Windows/Node 24 `spawn EINVAL` failure when a `.cmd` shim is launched from inside the orchestrator. On Ctrl-C it stops those host processes and intentionally leaves the sim container running so the container filesystem remains the working project state.

Docker Compose was deferred because a host-run backend can use the local Docker CLI directly; a composed backend would need Docker socket/CLI plumbing before it adds value for this single-user MVP.

## Verification

Static verification completed:

- `tsc --noEmit`
- `tsc --noEmit -p apps/web/tsconfig.json`
- `tsc --noEmit -p apps/server/tsconfig.json`

Manual end-to-end verification still requires Docker available to the caller: rebuild `frc-sim:mvp`, run `npm run dev:mvp`, open `http://localhost:3000`, edit `Robot.java`, click Run, and verify build output plus AS Lite reconnection.
