# FRC Web Simulator V2: Design Document

**Status:** V2 implementation plan
**Date:** 2026-05-09
**Audience:** Multiple coding agents implementing the V2 swap in coordinated stages
**Inputs:** `V1-Design.md`, current V1 source under `apps/`, `containers/`, `packages/contracts/`, `patches/advantagescope/`, openvscode-server docs, redhat.java extension docs, WPILib `vscode-wpilib` extension

This document is the contract for the V2 rewrite. It should be updated only when a stage discovers evidence that changes the design. Non-obvious changes need a new decision log under `docs/decisions/`.

V2 keeps the V1 control plane, run queue, NT4 proxy, AdvantageScope Lite serving, sessions, SQLite metadata, and admin/operator surface intact. It replaces the custom Monaco editor and the standalone JDT LS container with a single per-student container running upstream **openvscode-server** plus the **redhat.java** and **wpilibsuite.vscode-wpilib** extensions.

---

## 0. Decisions at a Glance

- **Editor:** upstream **openvscode-server** (Gitpod fork). Not coder/code-server. Not Microsoft `code serve-web`.
- **Java IDE features:** the **redhat.java** extension. Auto-import, ctrl-click into library classes, hover, diagnostics, semantic highlighting all come for free. JDT LS still runs, but inside the extension host, not as a separate container.
- **FRC tooling:** the upstream `wpilibsuite.vscode-wpilib` extension, vendored as a `.vsix` from the WPILib release artifacts. No marketplace dependency at runtime.
- **Optional:** `vscjava.vscode-gradle` if the spike shows it adds value.
- **Marketplace:** open-vsx default. Students may install extras locally; no lockdown work in V2.
- **Container shape:** one merged container per student, replacing the V1 sim and LSP containers. JDK 17, Gradle, WPILib cache, openvscode-server, baked extensions, all in the same image.
- **Bind mount:** `data/users/<workspaceId>/project/` is mounted at `/workspace/project` and is the workspace folder opened by openvscode-server.
- **Iframe URL:** `/u/<slug>/vscode/?folder=/workspace/project`, served same-origin under the existing `:4000` control plane.
- **Run/Stop:** stays in the shell header. The run queue now executes `docker exec <container> ./gradlew simulateJava` against the merged container and streams logs over the existing `/ws/run` WebSocket.
- **AdvantageScope:** still a sibling iframe at `/scope/`. The AdvantageScope-for-VS-Code webview extension is explicitly out of scope.
- **Data migration:** existing `data/users/<workspaceId>/project/` directories continue to work unchanged. `jdtls-data/` and the V1 LSP image become obsolete.

---

## 1. Context

V1 shipped a working classroom IDE: edit Java in Monaco, save through a project store, run a Gradle/WPILib sim in a per-student container, see telemetry in AdvantageScope Lite, and get hover/completion/diagnostics from a per-student JDT LS container behind a WebSocket bridge.

Two gaps in the editor matter enough to redo the editor layer:

1. **Auto-import on Tab does not work.** redhat.java returns `additionalTextEdits` on completion items that carry the `import` line. The current Monaco bridge does not forward those edits, so accepting `Pose2d` types only the symbol and leaves the file unimportable.
2. **Ctrl-click into library classes does not work.** JDT LS emits `jdt://` URIs for class file definitions like `Pose2d`. Resolving them needs a content provider that decompiles class file bytes. We do not ship one. Students cannot navigate into WPILib source.

Building both properly on Monaco is a long tail: `additionalTextEdits` plumbing, a `jdt://` content provider with `extractedClass`/`contents` query handling, command-palette parity, multi-cursor parity, debugger, terminal, theming. All of this already exists in upstream VS Code. Switching to openvscode-server collapses the tail, matches what students see if they ever install WPILib locally, and keeps JDT LS where the redhat.java team maintains it.

V2 is not a feature expansion. The classroom shape is the same: one teacher machine, ~10 students, browser tabs.

---

## 2. V2 Goals

V2 must deliver these capabilities on the same self-hosted classroom machine:

- Ten students can use the app concurrently without crossing projects, runs, or telemetry.
- Each student gets a full upstream VS Code editor experience: command palette, multi-cursor, debugger UI, terminal, multi-file nav, theming.
- Java auto-import on Tab works for WPILib types.
- Ctrl-click on `Pose2d` (or any WPILib class) opens its source.
- The edit/save/build/run/telemetry loop feels at least as good as V1.
- AdvantageScope Lite still connects to the correct student's NT4 stream.
- Idle teardown, restart adoption, signed cookies, admin operator API, and the run queue all continue to work.
- One command starts the V2 dev/classroom stack after setup.
- Student work persists across container restart, control-plane restart, and machine reboot.

---

## 3. Non-goals

V2 does not include:

- Multiple projects per student.
- Project template picker.
- Real-time collaborative editing.
- Driver station controls, gamepad input, enable/disable, mode selection.
- Migration to the AdvantageScope-for-VS-Code webview extension.
- Marketplace lockdown, extension allowlists, or curated extension catalogs.
- TLS, OAuth, SSO, roster integration.
- Public-internet deployment or hardened multi-tenant isolation.
- Per-student debugger port forwarding to the host.
- Anything in V1 non-goals that V1 already deferred.

---

## 4. Target Architecture

```
Browser
  |
  | HTTP and WS on one origin (:4000)
  v
+---------------------------------------------------------------+
| Bun control plane                                             |
|                                                               |
|  Router / static assets / AS Lite assets                      |
|  Session manager and workspace resolver                       |
|  Admin file API (seed, backup, restore)                       |
|  Run queue and log streaming                                  |
|  Container orchestrator (one merged container per workspace)  |
|  NT4 WebSocket proxy                                          |
|  openvscode-server HTTP proxy and WS proxy                    |
+---------------------+--------------------+--------------------+
                      |                    |
                      | host filesystem    | SQLite metadata
                      v                    v
              data/users/...           data/app.db
                      |
        bind mount /workspace/project
                      |
              +-------v-------+
              | code          |
              | container     |
              | per workspace |
              |               |
              | openvscode-   |
              | server        |
              |  + redhat.java|
              |  + wpilib ext |
              | JDK 17        |
              | Gradle/WPILib |
              | sim runner    |
              +-------+-------+
                      |
                      | NT4 5810, proxied only by control plane
                      | openvscode-server 3000, proxied only by control plane
                      v
        Browser receives:
          - editor iframe at /u/<slug>/vscode/
          - AS Lite iframe at /scope/?frcEndpoint=postMessage
          - run/log WebSocket at /u/<slug>/ws/run
```

The control plane is still the only browser-facing server, the only process that knows how a workspace maps to a container, host ports, and project paths. The merged container holds JDK 17, Gradle, the primed WPILib cache, the openvscode-server binary, and the baked extensions. No second container, no separate LSP bridge.

### 4.1 Channels

| Channel | Browser path | Control plane behavior | Upstream |
| --- | --- | --- | --- |
| App shell | `GET /u/:slug/` | Serve `apps/web/dist/index.html`, ensure container | none |
| Editor iframe | `GET /u/:slug/vscode/*` | HTTP proxy to openvscode-server in workspace container | `http://127.0.0.1:<vscodePort>` |
| Editor WebSocket | `WS /u/:slug/vscode/*` (upgrade) | WS proxy with subprotocol passthrough | `ws://127.0.0.1:<vscodePort>` |
| Run control | `WS /u/:slug/ws/run` | Existing run queue, runs `docker exec` against merged container | merged container |
| NT4 alive | `GET /u/:slug/sim/alive` | Probe sim NT4 endpoint inside merged container | `http://127.0.0.1:<nt4Port>/` |
| NT4 telemetry | `WS /u/:slug/sim/nt4` | Existing NT4 WS proxy with subprotocol | `ws://127.0.0.1:<nt4Port>/nt/AdvantageScopeLite` |
| AS Lite assets | `GET /scope/*` | Existing static serving from `dist/advantagescope/` | none |
| Admin status | `GET /admin/status` | Localhost or bearer-token gated | none |
| Admin actions | `POST /admin/workspaces/:id/...` | Restart, stop, reset, backup hooks | merged container |

### 4.2 What lives inside the merged container

- `openvscode-server` listening on container port `3000`.
- `redhat.java` extension pre-installed at image build time.
- `wpilibsuite.vscode-wpilib` extension pre-installed at image build time.
- JDK 17 on `PATH`.
- Gradle wrapper scripts (used through `./gradlew` from the project).
- Primed WPILib/Gradle cache under `/opt/frc-gradle-cache`, copied into the runtime `$GRADLE_USER_HOME` on first start (same trick V1 already uses).
- `start-sim.sh` and `stop-sim.sh` (carried over from V1 sim image, unchanged behavior) so the run queue can `docker exec` them.
- A non-root `frc` user with configurable UID/GID, matching V1.
- `tini` (or equivalent) as init.

### 4.3 What no longer exists

- The V1 LSP container, its image, and the JDT LS WebSocket-to-stdio bridge under `containers/lsp/bridge/bridge.ts`.
- The `containers/lsp/` directory.
- The control-plane LSP proxy code path (`/u/:slug/ws/lsp` route, `lspWebSocketResponse`, `probeLspBridgeReady`, `LspSocketData`, `lspStartupSemaphore`).
- The custom Monaco frontend code in `apps/web/src/main.tsx` and `apps/web/src/java-lsp.ts`.
- Student-facing file CRUD HTTP endpoints (`GET/PUT/POST/PATCH/DELETE /api/files*`, `GET /api/project/tree`).
- The `LSP_IMAGE`, `LSP_MEMORY_LIMIT`, `LSP_PORT_RANGE`, `LSP_STARTUP_CONCURRENCY` config knobs and their `.env.example` entries.
- `data/users/<workspaceId>/jdtls-data/` (no longer written by anything; existing dirs left in place are harmless).

---

## 5. Migration from V1

| Area | V1 state | V2 change |
| --- | --- | --- |
| Editor | Monaco in `apps/web` | iframe to openvscode-server |
| Java LSP | Per-student `frc-lsp` container with JDT LS bridge | Bundled inside merged container via `redhat.java` |
| Sim runtime | Per-student `frc-sim` container | Same image role, merged into the code container |
| File I/O | Browser to control-plane HTTP API to host FS | Editor in container writes directly to bind-mounted host FS |
| File tree | `GET /api/project/tree` | Removed; openvscode-server has its own tree |
| File CRUD | `GET/PUT/POST/PATCH/DELETE /api/files*` | Removed; admin seed/backup/restore endpoints replace what was kept |
| Run queue | `WS /u/:slug/ws/run` running `docker exec` against `frc-sim` | Same protocol, same queue, runs against the merged container |
| NT4 proxy | `/u/:slug/sim/{alive,nt4}` to `frc-sim` loopback port | Same endpoints, upstream is the merged container's NT4 port |
| AS Lite | `/scope/*` static + postMessage endpoint injection | Unchanged |
| Sessions | Signed cookie at `frc_v1_session` | Unchanged. Cookie name stays for compat |
| Admin API | `/admin/status`, restart sim/lsp, reset-lsp-data | Restart and stop adapt to single container; `reset-lsp-data` removed (redhat.java owns its index inside the container) |
| Containers in DB | `container_leases` with `sim_*` and `lsp_*` columns | Schema add for `vscode_*` columns, drop or stop using `lsp_*` columns; one row per workspace |
| Container labels | `frc-sim.role=sim` and `frc-sim.role=lsp` | New `frc-sim.role=code`, version `v2`. V1 labels still recognized only for cleanup |
| Idle teardown | Stops both sim and lsp | Stops the single code container |

Preserved exactly:

- Signed-cookie session, username picker, slug rules, route shape `/u/:slug/...`.
- Run queue semantics: 2 concurrent builds, position updates over the run WS, one active run per workspace, `start` supersedes prior run for that workspace.
- Container lifecycle: idle stop after 30 min, label-based reconciliation on control-plane restart, loopback-only port publishing.
- NT4 proxy with subprotocol preservation. Sim still binds `127.0.0.1:5810` inside the container.
- Admin operator API for status, restart, stop. Localhost-only by default; bearer token via `ADMIN_TOKEN`.
- SQLite database, plain SQL migrations under `apps/control/migrations/`, checksum-on-startup contract.
- AdvantageScope Lite source-level patches and the parent-to-iframe `postMessage` endpoint injection.
- `data/users/<workspaceId>/project/` as the source of truth for student work.

---

## 6. Domain Model Changes

### 6.1 IDs

Unchanged: `userId`, `workspaceId`, `workspaceSlug`, `sessionId`. Container names change shape:

```
frc-v2-code-<workspaceId>
```

Container labels:

```
frc-sim.managed=true
frc-sim.version=v2
frc-sim.role=code
frc-sim.workspace=<workspaceId>
```

Reconciliation also stops and removes orphaned `frc-sim.version=v1` containers when a workspace's V2 code container is created. V1 containers found without a workspace match are still treated as orphaned managed infrastructure and removed.

### 6.2 SQLite changes

A new migration adds the V2 columns and stops requiring the V1 LSP columns:

```
-- 004_v2_code_container.sql
ALTER TABLE container_leases ADD COLUMN vscode_container TEXT;
ALTER TABLE container_leases ADD COLUMN vscode_port INTEGER;
ALTER TABLE container_leases ADD COLUMN code_state TEXT NOT NULL DEFAULT 'missing';
CREATE UNIQUE INDEX idx_container_leases_vscode_port_unique
  ON container_leases(vscode_port)
  WHERE vscode_port IS NOT NULL;
```

The `lsp_container`, `lsp_port`, and `lsp_state` columns remain in place but are no longer written; a later cleanup migration may drop them.

`sim_container` and `sim_port` are reused: the merged container now publishes both port `5810` (NT4) and port `3000` (openvscode-server). Track them as `sim_port` and `vscode_port` respectively, on the same row.

### 6.3 Filesystem layout

```
data/
  app.db
  users/
    <workspaceId>/
      project/         authoritative student work; backup and restore this
      home/            $HOME for the frc user; gradle cache, openvscode-server User/, extensions/ all live here
      logs/runs/       transient run history
  backups/
    YYYY-MM-DD/        project snapshots only
```

`jdtls-data/` is no longer created. Existing directories are ignored. openvscode-server stores user settings under `/home/frc/.openvscode-server/data/User/` and per-machine extension state under `/home/frc/.openvscode-server/data/Machine/` and `/home/frc/.openvscode-server/extensions/` (or whatever path the chosen extensions dir resolves to). All of these are inside the bind-mounted home directory and survive container restart.

---

## 7. Public Routing Contract

### 7.1 Browser routes

```
GET  /                                login or redirect to current workspace
POST /login                           username picker submit
POST /logout                          clear session cookie
GET  /u/:workspaceSlug/               app shell
GET  /u/:workspaceSlug/assets/*       app shell static assets
GET  /scope/*                         shared AS Lite static assets
```

### 7.2 Editor proxy routes

All editor traffic flows through the proxy, gated on session ownership of the slug:

```
*    /u/:workspaceSlug/vscode/*       openvscode-server HTTP and WebSocket proxy
```

Both HTTP and WebSocket upgrades use the same prefix. The proxy strips the `/u/:workspaceSlug/vscode` prefix and forwards to the upstream. openvscode-server is launched with `--server-base-path /u/<slug>/vscode/` so the editor builds correct absolute URLs back into the proxy.

### 7.3 API routes

```
GET    /u/:workspaceSlug/api/session
POST   /u/:workspaceSlug/api/heartbeat
GET    /u/:workspaceSlug/api/containers/status
POST   /u/:workspaceSlug/api/run
POST   /u/:workspaceSlug/api/run/stop
```

Removed in V2:

```
GET    /u/:workspaceSlug/api/project/tree
GET    /u/:workspaceSlug/api/files
PUT    /u/:workspaceSlug/api/files
POST   /u/:workspaceSlug/api/files
PATCH  /u/:workspaceSlug/api/files/rename
DELETE /u/:workspaceSlug/api/files
```

### 7.4 Admin routes

```
GET   /admin/status
POST  /admin/workspaces/:workspaceId/restart-code
POST  /admin/workspaces/:workspaceId/stop-containers
POST  /admin/workspaces/:workspaceId/seed-template
POST  /admin/workspaces/:workspaceId/backup
POST  /admin/workspaces/:workspaceId/restore
```

`restart-sim`, `restart-lsp`, and `reset-lsp-data` are removed. `restart-code` replaces them. `seed-template`, `backup`, and `restore` cover the file operations the operator still needs without exposing student-facing CRUD.

### 7.5 WebSocket routes

```
WS /u/:workspaceSlug/ws/run           run queue, unchanged
WS /u/:workspaceSlug/sim/nt4          NT4 proxy, unchanged
WS /u/:workspaceSlug/vscode/*         editor proxy, new
```

`/u/:workspaceSlug/ws/lsp` is removed.

---

## 8. Container Design

### 8.1 Merged code image

Single Dockerfile under `containers/code/Dockerfile`. Build target: `frc-code:v2`.

Base layer:

```
FROM eclipse-temurin:17-jdk-jammy
```

Reuses what the V1 sim and LSP images already prove: glibc base, JDK 17, non-root `frc` user, primed Gradle cache pattern.

Build-time additions on top of the V1 sim layer:

1. Download the openvscode-server tarball from the Gitpod releases (pin the version in a build arg, e.g. `OPENVSCODE_VERSION=1.92.0`). Extract under `/opt/openvscode-server/`. Add `bin/` to `PATH`.
2. Vendor the required `.vsix` files under `vendor/vscode-extensions/` in the repo and `COPY` them into the image.
3. Install extensions at build time using openvscode-server's CLI:

   ```
   openvscode-server --install-extension /opt/extensions/redhat-java-<ver>.vsix \
                     --install-extension /opt/extensions/vscode-wpilib-<ver>.vsix \
                     --extensions-dir /home/frc/.openvscode-server/extensions
   ```

   Run this as the `frc` user so the resulting `extensions/` directory is owned correctly.

4. Keep the V1 sim's Gradle cache priming step (`./gradlew --no-daemon build` against the template, then copy `~/.gradle` to `/opt/frc-gradle-cache` for the entrypoint to seed at runtime). This prevents a 5-minute first-run dependency download for every student.
5. Carry over `containers/sim/start-sim.sh` and `containers/sim/stop-sim.sh` to `/usr/local/bin/`. Both still drive the run queue.

Entrypoint behavior:

```
#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/frc
export GRADLE_USER_HOME=$HOME/.gradle

# Seed gradle cache on first run, same as V1.
if [ -d /opt/frc-gradle-cache ] && [ ! -d "$GRADLE_USER_HOME/caches" ]; then
  cp -a /opt/frc-gradle-cache/. "$GRADLE_USER_HOME"/
fi

# Required by openvscode-server's logs and IPC paths.
mkdir -p /home/frc/.openvscode-server/data /home/frc/.openvscode-server/extensions

exec /opt/openvscode-server/bin/openvscode-server \
  --host 0.0.0.0 \
  --port 3000 \
  --without-connection-token \
  --server-base-path "${VSCODE_BASE_PATH:-/}" \
  --extensions-dir /home/frc/.openvscode-server/extensions \
  --user-data-dir /home/frc/.openvscode-server/data \
  /workspace/project
```

The container's primary process is openvscode-server. The run queue uses `docker exec` to drive sim build/run scripts, so the sim process is a child of the exec, not of the editor.

Runtime command shape:

```
docker run -d
  --name frc-v2-code-<workspaceId>
  --label frc-sim.managed=true
  --label frc-sim.version=v2
  --label frc-sim.role=code
  --label frc-sim.workspace=<workspaceId>
  --mount type=bind,src=<projectPath>,dst=/workspace/project
  --mount type=bind,src=<homePath>,dst=/home/frc
  -p 127.0.0.1:<vscodePort>:3000
  -p 127.0.0.1:<simPort>:5810
  --user <FRC_UID>:<FRC_GID>
  --memory=<codeMemoryLimit>
  -e VSCODE_BASE_PATH=/u/<slug>/vscode/
  frc-code:v2
```

### 8.2 Memory and concurrency

V1 used `1536m` per sim container and `1536m` per LSP container, totaling `3072m` per active student. V2 collapses to one container per student. Default starting point:

```
CODE_MEMORY_LIMIT=2560m
RUN_CONCURRENCY=2
IDLE_STOP_MINUTES=30
```

`2560m` covers JDT LS heap (the heaviest user inside the extension host), Gradle daemon during builds, and the sim JVM. Stage 6 measurements decide whether to raise or lower this.

### 8.3 UID/GID and bind mounts

Same policy as V1. Build with `FRC_UID` and `FRC_GID` matching the host user that owns `data/`. Run with `--user <FRC_UID>:<FRC_GID>`. On Docker Desktop / Windows the default `1000:1000` is fine for a personal classroom machine.

The bind-mounted `/home/frc` must be writable by that UID. Stage 1 verification includes checking that openvscode-server can write `extensions/`, `data/User/`, and `data/Machine/` from inside the container.

### 8.4 Port allocation

- `VSCODE_PORT_RANGE=33000-33099` for openvscode-server.
- `SIM_PORT_RANGE=25810-25899` retained for NT4.

Both come from the same per-workspace lease row. Allocation rules and reconciliation match V1: lowest free port in range, loopback-only publishing, free-port probe before reuse, port mismatch in Docker beats SQLite.

---

## 9. Editor Proxy

### 9.1 HTTP proxy

The proxy lives in `apps/control/src/app.ts` next to the existing NT4 path. For any request matching `/u/:slug/vscode/*`, the control plane:

1. Resolves the workspace slug using the existing `resolveWorkspaceRequest` helper.
2. Calls `containers.ensureCodeContainer(workspace)` (the renamed/merged ensure path).
3. Reads the `vscode_port` lease.
4. Builds the upstream URL: `http://127.0.0.1:<vscodePort><stripped-suffix>`. The suffix already includes the `/u/<slug>/vscode/` prefix because openvscode-server was launched with `--server-base-path /u/<slug>/vscode/`. Pass the path through unchanged.
5. Calls `fetch(upstreamUrl, { method, headers, body, redirect: "manual" })` and returns the streamed `Response` to the browser.

Header passthrough: forward all headers except hop-by-hop ones (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-authorization`, `proxy-authenticate`). The `cookie` header passes through untouched (it never reaches the openvscode-server because the proxy already authenticated, but the upstream ignores it harmlessly).

`Content-Type` and `Cache-Control` come back as-is. Do not inject any `<base>` or path rewriting; openvscode-server already does the right thing when given `--server-base-path`.

### 9.2 WebSocket proxy

For requests matching `/u/:slug/vscode/*` with `Upgrade: websocket`, upgrade through the same `Bun.serve` upgrade path used by the existing NT4 and LSP routes, then forward bytes both ways. Subprotocol passthrough is required: openvscode-server announces a subprotocol on the upgrade response, and the browser refuses the connection if our handshake response disagrees.

Reuse the `openProxyUpstream` helper pattern in `app.ts`. Add a third `vscode` socket kind alongside `nt4` and `run`. Upstream URL: `ws://127.0.0.1:<vscodePort><stripped-suffix>`.

Pending-message buffer cap (`PROXY_PENDING_LIMIT = 256`) is unchanged.

### 9.3 Tokenless mode

openvscode-server is launched with `--without-connection-token` because the control plane already authenticated the cookie before upgrading. Do not expose `vscodePort` to a non-loopback host address. Publishing only on `127.0.0.1` is enforced by the same loopback policy V1 uses for sim and LSP.

### 9.4 Health probe

Same shape as the V1 LSP probe: when ensuring a code container, the proxy waits up to 30 seconds for `GET http://127.0.0.1:<vscodePort><base-path>` to return any response in the 200-499 range before upgrading the browser WS or returning the editor HTML. Cold container start is dominated by the Gradle cache seed and the JDT LS heap warm-up; 30 seconds is the right ceiling.

---

## 10. Web Shell (V2)

### 10.1 Layout

The shell is much smaller in V2:

- **Header:** workspace name, Run, Stop, container/run status pills, Logout.
- **Main grid:**
  - left: `iframe` to `/u/:slug/vscode/?folder=/workspace/project`
  - right: `iframe` to `/scope/?frcEndpoint=postMessage`
- **Bottom panel:** console (run logs), unchanged shape.

No file tree, no Monaco editor, no LSP client, no save indicator. The console panel and run state pills carry over.

### 10.2 Run/Stop

The header Run button still posts to `/u/:slug/api/run` (or sends `start` over `/ws/run`). The control plane queues the run. The run command becomes:

```
docker exec <containerName> bash -lc "/usr/local/bin/stop-sim.sh || true && /usr/local/bin/start-sim.sh && tail --pid=<pid> -F /home/frc/sim.log"
```

The wrapping shell is identical to `dockerRunScript()` in `apps/control/src/runs.ts` today; the only change is the container name resolution path.

### 10.3 AS Lite iframe

Unchanged from V1. Parent posts:

```ts
{
  type: "frc-sim:set-nt4-endpoint",
  endpoint: {
    aliveUrl: "/u/<slug>/sim/alive",
    websocketUrl: "ws(s)://<host>/u/<slug>/sim/nt4",
  },
}
```

The iframe acks with `frc-sim:nt4-endpoint-ready`. Parent shows a "scope connecting" pill until ack or a 10 second timeout.

### 10.4 Heartbeat

Browser shell still posts `/u/:slug/api/heartbeat` every 60 seconds. Editor activity inside the iframe does not feed heartbeat directly; heartbeat plus run-WS activity plus container-status polls are enough to keep the workspace marked active during normal use.

### 10.5 Removal

`apps/web/src/main.tsx` shrinks from a multi-file Monaco IDE to a header + two iframes + a console panel. `apps/web/src/java-lsp.ts` and `apps/web/src/save-before-run.ts` are deleted. `monaco-editor` and `monaco-editor/esm/vs/editor/editor.worker?worker` come out of `apps/web/package.json`.

---

## 11. Resource Budget

V1 ran two containers per active student (about 3 GiB combined). V2 runs one. Initial sizing for 10 active students:

- 10 code containers at `2560m` cap = roughly 25 GiB worst case.
- Idle code containers stop after 30 minutes; only actively edited workspaces count.
- 32 GiB host RAM stays the recommended target; 16 GiB is workable for 5 students with `CODE_MEMORY_LIMIT=2048m` and `RUN_CONCURRENCY=1`.

Stage 7 must measure 3 active students on the target host before the V2 acceptance pass closes.

---

## 12. Failure Modes

| Failure | Detection | User behavior | Recovery |
| --- | --- | --- | --- |
| Code container OOM | Docker exit reason | Editor iframe shows "disconnected"; status pill flips to error | Recreate container; project files unchanged |
| openvscode-server crash inside container | Health probe fails on next request | Editor iframe shows reload prompt | Operator clicks `restart-code` or container auto-restarts via Docker |
| Gradle build timeout | Run queue timer | Run status `failed` with timeout log | Run queue stops sim process; files untouched |
| NT4 proxy target unavailable | Alive check fails | AS Lite shows reconnecting | Ensure code container, restart sim through run queue |
| Editor WS proxy upstream error | Bun WS error event | Browser reconnects automatically (openvscode-server has retry) | None needed unless container is stopped |
| Container stuck after restart | Lease present, container missing | Reconciliation clears lease and recreates | Background |
| Host disk full | File writes fail inside container | Save errors show in editor; build fails | Operator prunes regenerable home/ caches; never project/ |
| AS Lite patch drift | Build or smoke test fails after submodule bump | No release | Fix patch before bump lands |
| Bad slug | Route validation fails | 400/403 | None needed |

Every recovery path must preserve `data/users/<workspaceId>/project`.

---

## 13. Security Posture

V2 is still classroom-LAN. Required:

- Signed HttpOnly session cookie. Same name and shape as V1.
- SameSite=Lax cookie. Editor iframe must stay same-origin with the shell so cookies attach.
- No editor proxy access without cookie ownership of the slug.
- openvscode-server runs `--without-connection-token`; the control plane is the only auth boundary.
- All container ports published only on `127.0.0.1`.
- Docker container names and command args derived from validated IDs only. Use fixed argv arrays.
- Per-container memory caps.
- Admin endpoints localhost-only or bearer-token gated.

Explicitly deferred:

- TLS, OAuth, per-student passwords.
- Marketplace lockdown.
- Hardened multi-tenant isolation beyond Docker defaults.
- Restricting which extensions a student can install at runtime.

A student installing a malicious extension only damages their own workspace home directory. The bind mount is per-workspace and the container runs as a non-root user.

---

## 14. Verification

Required commands continue to exist:

```
bun run typecheck
bun test
bun run verify:v2:two-user
```

`verify:v2:two-user` replaces `verify:v1:two-user`. It boots two workspaces, opens both editor iframes (HTTP probe), runs both sims, and confirms that NT4 and run logs route to the right student.

Suggested unit tests:

- `packages/contracts`: V2 schemas (admin actions, code container state).
- `apps/control`: editor proxy path matching, vscode port allocation, container reconciliation against V1 leftovers.
- Editor proxy: subprotocol passthrough, hop-by-hop header stripping.

---

## 15. Staged Implementation Plan

Each stage is independently executable. A fresh agent given only this design document and the repo state at the end of the previous stage must be able to deliver the stage's definition of done.

Extension-owned Java IDE behavior was validated in Stage 0 and recorded in `docs/decisions/011-v2-editor-spike.md`. Later stages should not repeat manual or automated checks for redhat.java/WPILib extension features such as auto-import, F12/ctrl-click into `Pose2d`, hover, or diagnostics unless the openvscode-server, `redhat.java`, or `wpilibsuite.vscode-wpilib` versions change. Later verification should focus on simulator integration: the editor iframe loads through the control-plane proxy, the Java extension reaches a ready state, files persist in the mounted project, runs execute, and telemetry routes correctly.

### Stage 0: Spike outside the repo

**Purpose.** Prove that openvscode-server with `redhat.java` and the upstream `wpilibsuite.vscode-wpilib` extension delivers Java auto-import on Tab and ctrl-click into `Pose2d` for a real WPILib project. This is a kill switch; if it fails, the V2 plan needs revisiting before any other stage runs.

**Pre-conditions.** None. Do not modify the repo. Work in a throwaway directory.

**In scope.**

- A throwaway `Dockerfile` that runs openvscode-server with the two extensions baked in.
- A copy of `templates/wpilib-java-command/` mounted as the workspace.
- Manual browser verification of auto-import and ctrl-click navigation.

**Out of scope.**

- Anything inside `apps/`, `containers/`, `packages/`, `scripts/`.
- Same-origin proxy, control-plane integration.
- `.vsix` vendoring decisions for the production image.

**Implementation guidelines.**

- Use the official Gitpod openvscode-server release tarball: `https://github.com/gitpod-io/openvscode-server/releases`. Pin a version. Avoid the rolling `latest` for the spike.
- Get `redhat.java` from `https://open-vsx.org/extension/redhat/java` or the GitHub release `.vsix`.
- Get `wpilibsuite.vscode-wpilib` from `C:\Users\Public\wpilib\2026\` on the author's machine, or the WPILib release artifact. The WPILib `.vsix` may have native binaries on macOS/Windows; we only care that the Linux container path works. Verify by running `unzip -l <vsix>` and looking for prebuilt platform binaries; if the extension fails to activate in the spike, log the error and try the same vsix from the WPILib install (the install ships extensions matched to the platform).
- Launch with `--without-connection-token --host 0.0.0.0 --port 3000 /workspace/project`. Open `http://localhost:3000/?folder=/workspace/project` in a browser.
- Open `Robot.java`. Type `Pose2d` referencing it without an import. Accept the suggestion with Tab. Confirm the `import edu.wpi.first.math.geometry.Pose2d;` line is added by the editor (this exercises `additionalTextEdits`).
- Hold Ctrl and click on `Pose2d`. Confirm the editor opens a read-only buffer showing the class source (`jdt://` URI handled by redhat.java's content provider).

**Verification.**

```
docker build -t frc-spike-openvscode .
docker run --rm -p 3000:3000 -v $PWD/project:/workspace/project frc-spike-openvscode
# Browser:
#   http://localhost:3000/?folder=/workspace/project
#   Open Robot.java, type Pose2d, accept on Tab, see import line.
#   Ctrl-click Pose2d, see source open.
```

**Definition of Done.**

- [ ] openvscode-server boots in the spike container and serves on `:3000`.
- [ ] redhat.java activates against the WPILib starter project (status bar shows "Java is ready").
- [ ] Auto-import on Tab adds the `import` line for `Pose2d`.
- [ ] Ctrl-click on `Pose2d` opens the class source in a `jdt://` virtual buffer.
- [ ] Decision log `docs/decisions/011-v2-editor-spike.md` records: openvscode-server version, redhat.java version, wpilib extension version, and screenshots or copy-pasted symptoms for both behaviors.

If any check fails: stop. Open a follow-up question on the design document before proceeding.

---

### Stage 1: Merged container image

**Purpose.** Produce a `frc-code:v2` image that runs openvscode-server with both extensions baked in and can also run `./gradlew simulateJava` against a mounted project. Hand-launched container must serve the editor and accept a `docker exec` run command.

**Pre-conditions.** Stage 0 passed. Decision log 007 exists. The repo is otherwise V1.

**In scope.**

- New directory: `containers/code/` with `Dockerfile`, `entrypoint.sh`, plus carryovers `start-sim.sh` and `stop-sim.sh` (copy from `containers/sim/`, do not delete the V1 originals yet).
- New directory: `vendor/vscode-extensions/` containing the pinned `.vsix` files for `redhat.java` and `wpilibsuite.vscode-wpilib`. Document provenance in `vendor/vscode-extensions/README.md`.
- New script: `scripts/build-code-image.ts` modeled on `scripts/build-sim-image.ts`. Wires `bun run docker:build:code`.
- Update `package.json` scripts to include `docker:build:code`.

**Out of scope.**

- Removing the V1 sim and LSP images or scripts. They stay until Stage 3 cuts over.
- Any control-plane code change.
- `apps/web` change.
- `.env.example` updates to default `CODE_*` vars (Stage 3).

**Implementation guidelines.**

- Base on `eclipse-temurin:17-jdk-jammy` so JDK, glibc, and gradle priming match V1 exactly.
- Pin `OPENVSCODE_VERSION` as a `--build-arg`. Default: the version that passed Stage 0. Download the Linux x64 tarball from `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${VER}/openvscode-server-v${VER}-linux-x64.tar.gz`.
- Run `--install-extension <vsix>` as the `frc` user, with `--extensions-dir /home/frc/.openvscode-server/extensions`. This must happen during build so the live container does not need internet.
- Native-dep gotcha: if `wpilibsuite.vscode-wpilib` includes platform-specific binaries that are not for `linux-x64`, swap the vendored `.vsix` for the matching one from the WPILib `2026` install. The vendored copy is the source of truth; do not download at build time.
- Carry over the V1 sim's gradle priming step. Run `./gradlew --no-daemon build` against `templates/wpilib-java-command/` during build, then move `~/.gradle` to `/opt/frc-gradle-cache/` and have the entrypoint copy it into `$GRADLE_USER_HOME` on first run if missing. The LSP image's priming logic is the model.
- Do not run `--server-base-path` at build time; it is a runtime argument.
- Make `start-sim.sh` and `stop-sim.sh` work unchanged. The run queue depends on them.
- Set `tini` as PID 1 (same as V1).

**Verification.**

```
bun run docker:build:code

# Hand-launched, no proxy:
docker run --rm -d \
  --name frc-code-spike \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:5810:5810 \
  -v "$PWD/data/users/<some-existing-workspace>/project:/workspace/project" \
  -v "$PWD/data/users/<some-existing-workspace>/home:/home/frc" \
  -e VSCODE_BASE_PATH=/ \
  --user $(id -u):$(id -g) \
  frc-code:v2

# HTTP check:
curl -fsS http://127.0.0.1:3000/ | head -c 200      # should return openvscode-server HTML
# Editor check (manual):
#   open http://127.0.0.1:3000/?folder=/workspace/project
#   confirm Java reaches ready. Do not repeat Stage 0 auto-import/F12 checks
#   unless editor or extension versions changed.

# Run check:
docker exec frc-code-spike bash -lc "/usr/local/bin/start-sim.sh"
docker exec frc-code-spike bash -lc "tail -n 5 /home/frc/sim.log"
docker exec frc-code-spike bash -lc "/usr/local/bin/stop-sim.sh"

docker rm -f frc-code-spike
```

**Definition of Done.**

- [ ] `bun run docker:build:code` succeeds on a clean machine and produces `frc-code:v2`.
- [ ] Image size is documented in `containers/code/README.md` (informational only).
- [ ] `containers/code/Dockerfile` references vendored `.vsix` files; build succeeds with the host offline.
- [ ] Hand-launched container serves openvscode-server on `:3000` and answers HTTP within 30 seconds of `docker run`.
- [ ] Java reaches ready in the hand-launched container against a real `templates/wpilib-java-command/` project. Stage 0 already covers redhat.java auto-import and WPILib source navigation; repeat those only after editor or extension version changes.
- [ ] `docker exec ... /usr/local/bin/start-sim.sh` produces an NT4 endpoint reachable on `127.0.0.1:5810`.
- [ ] `vendor/vscode-extensions/README.md` records the source URL or local path and version of every bundled `.vsix`.

---

### Stage 2: Editor proxy in the control plane

**Purpose.** Add HTTP and WebSocket proxy routes for openvscode-server under `/u/:slug/vscode/*`, gated by the existing session cookie. Verify against a hand-launched Stage 1 container without changing the orchestrator yet.

**Pre-conditions.** Stage 1 image builds. The control plane is otherwise V1.

**In scope.**

- `apps/control/src/app.ts`:
  - new helper `vscodeProxyResponse(...)` for HTTP, modeled on `nt4WebSocketResponse`.
  - new socket kind `vscode` alongside `nt4`, `lsp`, `run`. Reuse `openProxyUpstream`.
  - new route arm in `fetch()` matching `^/u/<slug>/vscode(/.*)?$` for both methods.
  - hop-by-hop header stripping helper for the HTTP path.
- A temporary configuration knob for the upstream port: `VSCODE_DEV_UPSTREAM_PORT=3000` (or read from a per-workspace lease once available). Stage 3 replaces this with proper orchestration.
- New unit tests in `apps/control/src/app.test.ts` covering:
  - unauthenticated `/u/<slug>/vscode/` returns 401 (or redirect for page kind).
  - cross-workspace `/u/<other>/vscode/` returns 403.
  - hop-by-hop headers (`connection`, `upgrade`, `keep-alive`) are not forwarded.
  - subprotocol on WS upgrade is echoed back to the browser when upstream agrees.

**Out of scope.**

- Container orchestration changes. The orchestrator still launches V1 sim and LSP. The proxy targets a hand-launched code container during this stage.
- Removal of the existing LSP proxy code or `frc-lsp` container. Both still run.
- Any web shell change.

**Implementation guidelines.**

- The base path `/u/<slug>/vscode/` must match what openvscode-server is launched with. Pass the path through unchanged (do not rewrite). openvscode-server's bundled UI uses absolute URLs that already include the base path.
- HTTP forwarding via `fetch(upstreamUrl, { method, headers, body, redirect: "manual" })` and stream the body back. Do not buffer. Set `Bun`'s `decompress: false` if available; let upstream gzip pass through.
- Hop-by-hop headers to strip on both directions: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`. Add the values listed in the inbound `connection` header to the strip set as well.
- Cookies pass through. The upstream openvscode-server runs `--without-connection-token` and ignores cookies.
- WebSocket: pattern after the existing NT4 proxy. Pull `sec-websocket-protocol` from the request, pass it to `new WebSocket(upstreamUrl, protocols)`, and echo the chosen subprotocol back via `headers["sec-websocket-protocol"]` on `server.upgrade(...)`.
- Cap pending-message buffering at `PROXY_PENDING_LIMIT = 256`, same as NT4 and LSP.
- Probe the upstream HTTP path before upgrading the browser WS, just like `probeLspBridgeReady`. Return `503` if the upstream is not ready in 30 seconds.

**Verification.**

```
# Build and start a Stage 1 container manually.
docker run -d --name frc-code-dev \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/data/users/<wsId>/project:/workspace/project" \
  -v "$PWD/data/users/<wsId>/home:/home/frc" \
  -e VSCODE_BASE_PATH=/u/<slug>/vscode/ \
  --user $(id -u):$(id -g) \
  frc-code:v2

bun run dev:control      # control plane on :4000

# Login as the user owning <slug> through the browser.

# HTTP smoke:
curl -fsS -b cookies.txt http://localhost:4000/u/<slug>/vscode/ | head -c 200

# Browser smoke:
#   open http://localhost:4000/u/<slug>/vscode/?folder=/workspace/project
#   confirm the editor loads through the proxy and Java reaches ready.
#   Do not repeat Stage 0 auto-import/F12 checks unless versions changed.

# Cross-workspace negative:
curl -i -b cookies.txt http://localhost:4000/u/<other>/vscode/   # expect 403

bun run typecheck
bun test
```

**Definition of Done.**

- [ ] Authenticated user can load `/u/<slug>/vscode/?folder=/workspace/project` in a browser and see openvscode-server.
- [ ] WebSocket upgrade succeeds; the editor's terminal, file watcher, and language server initialize through the proxy. Auto-import and ctrl-click source navigation remain covered by Stage 0 unless editor or extension versions changed.
- [ ] Cross-workspace access returns `403`.
- [ ] Unauthenticated access returns `401` for API kind, `303` redirect for page kind.
- [ ] `bun test` covers the four scenarios listed under "In scope".
- [ ] `bun run typecheck` passes.
- [ ] No code paths under `/u/<slug>/ws/lsp` are removed in this stage.

---

### Stage 3: Orchestrator merge and run-path migration

**Purpose.** Replace the V1 sim and LSP containers with a single merged code container per workspace. The control plane orchestrator now ensures, adopts, restarts, and stops one container per workspace. The run queue executes against that container. Editor proxy reads `vscode_port` from the lease.

**Pre-conditions.** Stage 1 image builds. Stage 2 proxy works against a hand-launched container.

**In scope.**

- `apps/control/migrations/004_v2_code_container.sql`: adds `vscode_container`, `vscode_port`, `code_state` columns and the unique index on `vscode_port`.
- `apps/control/src/storage.ts`: `ContainerLeaseRow` adds `vscode_container`, `vscode_port`, `code_state`. New helpers mirror existing sim/lsp ones for the code role.
- `apps/control/src/containers.ts`:
  - new `RoleConfig` for `role: "code"`, container port `3000`, name prefix `frc-v2-code-`.
  - merge sim and lsp ensure paths into a single code ensure path. The merged container publishes both `5810` and `3000` from the same `docker run`.
  - delete the LSP startup semaphore (no separate JDT LS warmup).
  - reconciliation: adopt `frc-sim.version=v2 role=code` containers; stop and remove `frc-sim.version=v1 role=sim|lsp` orphans.
  - `restartCodeContainer`, `stopWorkspaceContainers` adapted to the single container.
- `apps/control/src/runs.ts`: change `runs.start()` and `defaultRunCommandFactory` to target the code container. The `start-sim.sh` and `stop-sim.sh` calls are unchanged.
- `apps/control/src/app.ts`:
  - delete `lspWebSocketResponse`, `LspSocketData`, `probeLspBridgeReady`, the `/ws/lsp` route, and the `ws/lsp` socket kind.
  - editor proxy now reads `vscode_port` from the lease via `containers.ensureCodeContainer(workspace)`.
- `apps/control/src/config.ts`:
  - replace `simImage`, `lspImage`, `simMemoryLimit`, `lspMemoryLimit`, `simPortRange`, `lspPortRange`, `lspStartupConcurrency` with `codeImage`, `codeMemoryLimit`, `vscodePortRange`. Keep `simPortRange` for the NT4 publish.
- `containers/lsp/` directory deleted.
- `scripts/build-lsp-image.ts` and `bun run docker:build:lsp` removed. `containers/sim/` Dockerfile and scripts deleted (kept content was moved into `containers/code/` in Stage 1).
- `.env.example` updated: drop LSP_*, add CODE_*, add VSCODE_PORT_RANGE.

**Out of scope.**

- Web shell change.
- Removal of the file CRUD endpoints and `packages/contracts` schemas (Stage 4).
- Backup/restore admin endpoints (Stage 4).

**Implementation guidelines.**

- Single `docker run` for both ports:
  - `-p 127.0.0.1:<vscodePort>:3000`
  - `-p 127.0.0.1:<simPort>:5810`
  - `-e VSCODE_BASE_PATH=/u/<slug>/vscode/`
  - both bind mounts (project and home).
- Allocate `simPort` and `vscodePort` together inside the same lease transaction so reconciliation can not see a split state.
- The publish-port reconciliation logic must inspect both ports; a container that publishes one port on `127.0.0.1` and the other on `0.0.0.0` (or any non-loopback) is unsafe and must be removed.
- Reconcile V1 leftovers: on startup, find containers with `frc-sim.version=v1` and `frc-sim.role in (sim, lsp)`. Stop and remove them. Their workspaces' leases should be cleared and re-ensured next time the workspace opens.
- Run queue command resolution: `runs.start()` calls `containers.ensureCodeContainer(workspace)` instead of `ensureSimContainer`. The `RunCommandContext.containerName` now points at the code container. The shell script inside `dockerRunScript()` is unchanged.
- When deleting the LSP path, remove related schemas in `packages/contracts/src/index.ts` only if they are not still used by `AdminWorkspaceStatus`. Keep the admin status response useful: replace `lsp` with `code`, drop `lsp` field.
- Update `apps/control/src/app.ts` admin handlers: `restart-sim` becomes `restart-code` (rename), `restart-lsp` and `reset-lsp-data` are deleted, `stop-containers` keeps its name.

**Verification.**

```
bun run typecheck
bun test
bun run docker:build:code

# End-to-end with the existing web shell still in place. The Monaco UI is not
# yet replaced, so the editor pane will be broken; this stage does not need
# the editor pane to work. The proxy path and run path are what we test.
bun run dev:control

# Login as alice, then:
curl -fsS -b cookies.txt http://localhost:4000/u/alice/vscode/ | head -c 200
curl -fsS -b cookies.txt http://localhost:4000/u/alice/api/containers/status

# Run smoke:
#   open browser dev tools, connect to /u/alice/ws/run, send {"type":"start"}
#   confirm gradle logs stream and status reaches "running".

# Reconciliation smoke:
#   stop the control plane.
#   restart it.
#   confirm `docker ps` shows the same `frc-v2-code-<wsId>` container,
#   and that `/u/alice/api/containers/status` reports the same vscode_port.

# Negative: confirm `frc-v1-sim-*` and `frc-v1-lsp-*` containers, if any
# remain on disk, are stopped/removed within 60 seconds of restart.
```

**Definition of Done.**

- [ ] Migration 004 applies cleanly and `bun run migrate:status` shows it green.
- [ ] One `docker ps` row per active workspace, named `frc-v2-code-<wsId>`.
- [ ] `containers/lsp/` and `containers/sim/` are removed from the repo.
- [ ] `bun run docker:build:lsp` and `bun run docker:build:sim` no longer exist.
- [ ] Run queue runs `simulateJava` inside the merged container; logs reach the run WS.
- [ ] NT4 alive and WS proxy still pass smoke against the merged container.
- [ ] Editor proxy reads `vscode_port` from the live lease (no hardcoded port).
- [ ] V1 sim and LSP containers found at startup are stopped and removed by reconciliation.
- [ ] `bun run typecheck` and `bun test` pass.
- [ ] No code path references `lspImage`, `lspPort`, `lspStartupSemaphore`, `JDTLS_*`, or `probeLspBridgeReady`.

---

### Stage 4: Web shell swap

**Purpose.** Replace the V1 Monaco-based shell with a header + iframe(openvscode-server) + iframe(AS Lite) + console panel.

**Pre-conditions.** Stage 3 ships a working merged container, editor proxy, and run queue. The browser can already load the editor at `/u/:slug/vscode/?folder=/workspace/project`.

**In scope.**

- `apps/web/src/main.tsx`: rewrite to a small React component that renders the header, two iframes, and the console panel.
- `apps/web/src/style.css`: simplified grid layout.
- Delete `apps/web/src/java-lsp.ts`.
- Delete `apps/web/src/save-before-run.ts` and `apps/web/src/save-before-run.test.ts`.
- `apps/web/package.json`: drop `monaco-editor`. Keep `react`, `react-dom`, `@frc-sim/contracts`.
- `apps/web/index.html`: trim Monaco-related assets.

**Out of scope.**

- Removing `/api/files*` routes from the control plane (Stage 5).
- Admin endpoints for backup/restore (Stage 5).

**Implementation guidelines.**

- Iframe `src` for the editor: `/u/<slug>/vscode/?folder=/workspace/project`. Set `allow="clipboard-read; clipboard-write"` and `sandbox` only if it is verified not to break the editor. Default to no sandbox attribute; same-origin already provides the cookie path.
- Iframe `src` for AS Lite: `/scope/?frcEndpoint=postMessage`. Reuse the V1 postMessage handshake from `apps/web/src/main.tsx`.
- Header pills:
  - container/run status (queued, building, running, failed, stopped, error)
  - sim/AS connection state (connecting, connected, timeout)
  - editor reachable (probed via `/u/<slug>/vscode/` GET; pill turns red on 5xx)
- Run/Stop buttons post to the existing run queue WebSocket; no API change.
- Heartbeat continues to fire every 60s. Editor activity inside the iframe does not feed the heartbeat directly.
- Save-before-run is no longer needed; openvscode-server saves to disk on the user's keystroke or auto-save preference.
- Console panel reads from the same run WS messages.

**Verification.**

```
bun run build:web
bun run dev:control

# Login as alice:
#   browser shows the new shell.
#   editor iframe loads.
#   AS Lite iframe loads and shows "scope connected" within 2 seconds of sim run.

#   Confirm the editor iframe loads through the control-plane proxy and Java reaches ready.
#   Do not re-test extension-owned auto-import/F12 behavior unless extension versions changed.
#   Click Run in header -> console streams build logs, status flips to running.
#   Click Stop -> status flips to stopped.

#   Reload browser -> shell reloads, work persists, editor reopens last buffer (vscode-server saves layout in the bind-mounted home dir).
```

**Definition of Done.**

- [x] `apps/web/src` no longer imports `monaco-editor`.
- [x] `apps/web/dist/` build output does not include Monaco bundles.
- [x] Editor iframe is the only way the user reads or writes files.
- [x] Run/Stop, console panel, AS Lite iframe all function as before.
- [x] `bun run typecheck` passes.
- [x] `bun test` passes.

---

### Stage 5: File API and contracts cleanup

**Purpose.** Remove student-facing file CRUD; add admin-only endpoints for seeding the starter template, taking a backup, and restoring a backup. Trim contracts.

**Pre-conditions.** Stage 4 shipped; the editor iframe is the canonical file I/O path.

**In scope.**

- `apps/control/src/app.ts`:
  - delete `/u/:slug/api/files`, `/u/:slug/api/files/rename`, `/u/:slug/api/project/tree`.
  - delete `readProjectFile`, `writeProjectFile`, `createProjectEntry`, `renameProjectEntry`, `deleteProjectEntry`, `projectTreeResponse`, `readProjectTreeNode`, related helpers.
  - keep `resolveProjectFilePath` only if admin endpoints need it; otherwise delete.
  - add `POST /admin/workspaces/:workspaceId/seed-template` that copies `templates/wpilib-java-command/` into the workspace project dir if the dir is empty.
  - add `POST /admin/workspaces/:workspaceId/backup` and `POST /admin/workspaces/:workspaceId/restore` that delegate to `scripts/backup.ts` and `scripts/restore.ts` (or to inline equivalents).
- `packages/contracts/src/index.ts`:
  - delete `writeFileRequestSchema`, `createFileRequestSchema`, `renameFileRequestSchema`, `projectTreeNodeSchema`, `projectTreeResponseSchema`, `projectFileResponseSchema`, `fileMutationResponseSchema`, `getProjectPathAccess`, `ProjectPath` type, `projectPathSchema`, `parseProjectPath`, `isProjectPath`. Keep them only if admin endpoints still need them.
  - keep `runClientMessageSchema`, `runServerMessageSchema`, session and admin schemas.
- Delete tests in `apps/control/src/app.test.ts` and `packages/contracts/src/index.test.ts` covering removed surface.
- Add tests for the three new admin endpoints.

**Out of scope.**

- Editor proxy changes.
- Container orchestrator changes beyond what `seed-template` needs.

**Implementation guidelines.**

- `seed-template` is idempotent: if the project directory exists and is non-empty, return `409`. The admin caller decides whether to delete first.
- `backup` writes to `data/backups/<YYYY-MM-DD-HHMMSS>/<workspaceId>/project.tar.gz`. Reuse `scripts/backup.ts` if its argv allows targeting a single workspace; otherwise extract a shared `backupWorkspace(workspaceId)` helper.
- `restore` reads from a path passed in the request body and overwrites `project/`. Validate the source path stays under `data/backups/`.
- Do not introduce a "clear all files" admin endpoint. Removal is `seed-template` of a fresh dir or manual filesystem work.
- The frontend never calls these admin endpoints.

**Verification.**

```
bun run typecheck
bun test

# Negative regression:
curl -i -b cookies.txt http://localhost:4000/u/alice/api/files?path=Robot.java   # expect 404 (route removed)

# Admin smoke (localhost only):
curl -fsS -X POST http://localhost:4000/admin/workspaces/<wsId>/seed-template
curl -fsS -X POST http://localhost:4000/admin/workspaces/<wsId>/backup
ls data/backups/
curl -fsS -X POST http://localhost:4000/admin/workspaces/<wsId>/restore \
  -H content-type:application/json \
  -d '{"path":"data/backups/<dir>/<wsId>/project.tar.gz"}'
```

**Definition of Done.**

- [ ] No route under `/u/:slug/api/files*` or `/u/:slug/api/project/tree` exists.
- [ ] `packages/contracts/src/index.ts` is shorter; deleted exports are not referenced anywhere.
- [ ] Admin `seed-template`, `backup`, `restore` work for a real workspace.
- [ ] `bun run typecheck` and `bun test` pass with the new admin tests.

---

### Stage 6: Lifecycle, labels, and reconciliation

**Purpose.** Verify and adjust idle teardown, restart adoption, and admin operator actions for the single-container shape.

**Pre-conditions.** Stages 1-5 complete.

**In scope.**

- `apps/control/src/idle.ts`: confirm `stopWorkspaceContainers` stops the single code container.
- `apps/control/src/containers.ts`:
  - `restartCodeContainer` exists and is the only restart action.
  - reconciliation handles: no row, container exists; row exists, container missing; row exists, container exists with mismatched ports; row exists, V1 leftover container exists.
- `apps/control/src/app.ts`: admin actions list reflects V2 (`restart-code`, `stop-containers`, `seed-template`, `backup`, `restore`).
- `apps/control/src/app.test.ts`: tests for adoption of an existing V2 container after control-plane restart, and for V1 leftover removal.

**Out of scope.**

- New features.
- Web shell change.

**Implementation guidelines.**

- The label match must require both `frc-sim.version=v2` and `frc-sim.role=code` to count as managed. V1-labeled containers that match the same workspace ID are still managed by us, but only for cleanup.
- Idle timer remains 30 minutes by default. Activity sources unchanged: heartbeat, `/api/containers/status`, run-WS messages. Editor iframe activity does not directly bump activity, but the heartbeat covers it.
- Recovery from a stuck container: if `containers status` reports `code_state=error` for >2 minutes, an operator runs `restart-code`. `restart-code` does `docker stop`, `docker rm -f`, clear the lease, then re-ensure.

**Verification.**

```
# Idle teardown:
bun run dev:control
# Login alice; open editor; do nothing for IDLE_STOP_MINUTES=2 (override env for the test).
# Confirm `docker ps` no longer shows alice's code container.
# Reload alice's tab; confirm a new code container is created and the editor reloads.

# Adoption:
bun run dev:control
# Login alice; let container come up.
# kill -9 the control plane.
# bun run dev:control again.
# Confirm the same `frc-v2-code-<wsId>` container is reused (ID unchanged in `docker ps`).

# Admin actions:
curl -fsS -X POST http://localhost:4000/admin/workspaces/<wsId>/restart-code
curl -fsS -X POST http://localhost:4000/admin/workspaces/<wsId>/stop-containers

# V1 leftover cleanup:
docker run -d --name frc-v1-sim-fake \
  --label frc-sim.managed=true --label frc-sim.version=v1 --label frc-sim.role=sim --label frc-sim.workspace=<wsId> \
  alpine sleep 3600
# Restart the control plane.
# Confirm `docker ps -a` no longer shows frc-v1-sim-fake within 60 seconds.
```

**Definition of Done.**

- [x] Idle teardown stops one container per idle workspace.
- [x] Reload after teardown brings the editor back without losing project files or vscode user data.
- [x] Control-plane restart adopts the existing code container (no recreate).
- [x] V1 leftover containers are stopped and removed within one reconciliation cycle.
- [x] `restart-code` and `stop-containers` admin actions return 200 for a running workspace.
- [x] `bun test` covers reconciliation cases.

---

### Stage 7: Acceptance pass

**Purpose.** End-to-end smoke against three concurrent workspaces. Operator runbook updated. V2 declared done.

**Pre-conditions.** Stages 1-6 complete on a clean checkout.

**In scope.**

- `scripts/verify-v2-two-user.ts` and `scripts/verify-v2-three-user-smoke.ts`, modeled on the V1 versions. They open editor proxies, post run starts, validate run logs, and check NT4 endpoints.
- `package.json`: `verify:v2:two-user`, `verify:v2:three-user`. Remove the V1 `verify:v1:*` scripts.
- `docs/runbook.md` updated for V2 (build commands, env vars, idle behavior).
- `docs/decisions/008-v2-acceptance.md` recording measurements: per-container RAM at idle, RAM under load, build time delta vs V1, editor cold-start time.
- `AGENTS.md` updated: V2 status, V2 stack rule (openvscode-server + bundled extensions).
- `README.md` updated: V2 quickstart.

**Out of scope.**

- New features.

**Implementation guidelines.**

- Smoke scripts should fail fast on first error and print the offending workspace + step.
- Editor smoke is HTTP-only (the openvscode-server bundle is HTML+JS; we do not headlessly evaluate it). Pull `/u/<slug>/vscode/` and verify a 200 plus a marker substring like `"openvscode"` or `"vscode-workbench"` in the body.
- Run smoke uses the same WebSocket dance as V1: connect to `/u/<slug>/ws/run`, send `start`, expect `status: running` within `RUN_BUILD_TIMEOUT_MS + SIM_STARTUP_TIMEOUT_MS`.
- NT4 smoke uses a tiny WS client connecting to `/u/<slug>/sim/nt4` with the AS Lite subprotocol and confirms a few NT topic announcements arrive.

**Verification.**

```
bun run docker:build:code
bun run build:web
bun run build:ascope
bun run dev:control &

bun run verify:v2:two-user
bun run verify:v2:three-user

bun run measure         # capture current RAM and CPU
```

**Definition of Done.**

- [x] `verify:v2:two-user` and `verify:v2:three-user` pass on the target host.
- [x] Decision log 013 records per-container memory and time-to-editor-ready.
- [x] `docs/runbook.md` and `README.md` only reference V2 commands and images.
- [x] `AGENTS.md` declares V2 done and points to this document.
- [x] No V1-only files remain except `mvp/` (untouched).

---

## 16. Manual End-to-End Test Plan

After all stages are complete, an operator runs this sequence on a clean machine to confirm V2 works.

**Setup once.**

```
git clone <repo-url> FRC-Programming-Training-Sim
cd FRC-Programming-Training-Sim
git submodule update --init --recursive
bun install
cp .env.example .env
# edit .env: set FRC_SESSION_SECRET=<random string>
```

**Build images and assets.**

```
bun run docker:build:code
bun run build:web
bun run build:ascope
```

**Apply migrations and start the control plane.**

```
bun run migrate
bun run dev:control
# Expect "V2 control plane listening on http://localhost:4000".
```

**Provision a smoke-test student.**

```
# In another shell:
curl -fsS -X POST http://localhost:4000/login \
  -d 'displayName=Alice' -c cookies.txt -L --output /dev/null
# Or: open http://localhost:4000 in a browser, type "Alice", click Enter.
```

**End-to-end checks.**

1. **Shell loads.** Browse to `http://localhost:4000/`. Login as `Alice`. Confirm the V2 shell renders: header (Run, Stop, Logout, status pills), editor iframe on the left, AS Lite iframe on the right, console panel on the bottom.

2. **Editor loads.** The editor iframe shows the WPILib starter project with `Robot.java` open, a file tree on the left, and "Java is ready" in the status bar.

3. **Java extension ready.** Confirm the editor status bar reaches "Java is ready". Do not re-run auto-import/F12 checks here unless the pinned editor or Java extension versions changed after Decision 011.

4. **Run streams.** Click Run in the header. Confirm Gradle build logs stream into the console panel. The status pill flips through `building` to `running`.

5. **NT4 telemetry.** Wait for the AS Lite iframe to flip from "scope connecting" to "scope connected". Confirm telemetry from the running sim appears (the WPILib starter publishes counters).

6. **Stop.** Click Stop. Confirm the status pill flips to `stopped` and the sim process inside the container exits.

7. **Persistence across logout/login.** Click Logout. Wait 5 seconds. Login as `Alice` again. Confirm the editor reopens with any code the operator added.

8. **Persistence across container restart.** As an admin, run:

   ```
   curl -fsS -X POST http://localhost:4000/admin/workspaces/<aliceWsId>/restart-code
   ```

   Reload Alice's browser. Confirm the editor reloads with the same buffer state and the same Java state.

9. **Idle teardown.** Set `IDLE_STOP_MINUTES=2` in `.env`, restart the control plane, log in as Alice, then leave the tab idle for 3 minutes. Run `docker ps`. Confirm `frc-v2-code-<aliceWsId>` is gone. Reload the tab. Confirm the editor comes back and Alice's files are intact.

10. **Multi-user isolation.** In a second browser profile, log in as `Bob`. Make a unique change in Bob's `Robot.java`. Reload Alice. Confirm Alice's file is unchanged.

11. **Run queue.** With `RUN_CONCURRENCY=1`, click Run for both Alice and Bob within 2 seconds. Confirm one of them shows `queued` with a queue position; the other reaches `running`. After the first finishes, the queued run advances.

12. **Operator restart.** While a build is running, hit:

    ```
    curl -fsS -X POST http://localhost:4000/admin/workspaces/<aliceWsId>/stop-containers
    ```

    Confirm Alice's run flips to `failed`/`stopped` cleanly without affecting Bob.

If any check fails, the V2 acceptance pass is not done. File a bug, fix, retest the affected check.

---

## 17. Open Questions

Resolve before or during the named stage:

- **openvscode-server version pin.** Stage 0 picks one. Stage 1 promotes it to a build arg. Bump only with a decision log.
- **WPILib `.vsix` source.** Stage 0 verifies the open-vsx or GitHub release vsix activates on Linux. Stage 1 vendors whichever variant is provably correct.
- **Per-workspace memory cap.** Stage 7 measurements decide whether `2560m` is right. Adjust `CODE_MEMORY_LIMIT` default if measurements force a change.
- **Backup destination ownership on Windows.** Stage 5 must verify `bun run backup` and `restore` work on a Windows host with non-POSIX file modes. The V1 scripts handled this; confirm V2 inherits the behavior.
- **Browser support.** Same as upstream openvscode-server. Stage 7 spot-checks Chromium and Firefox.

---

## 18. Rules for Agents

- Read this document before implementing any V2 stage.
- Read `V1-Design.md` when copying or adapting V1 behavior. Do not regress V1 invariants that V2 says it preserves.
- Keep stage boundaries intact. Do not pull future-stage work forward unless the current contract is otherwise wrong.
- Update `packages/contracts` before changing API shapes.
- Add a decision log under `docs/decisions/` for every non-obvious architecture or tooling choice.
- Preserve student data under `data/users/<workspaceId>/project`.
- Do not expose openvscode-server or NT4 ports directly to the browser. The proxy is the only path.
- Keep openvscode-server tokenless behind the auth proxy. Do not introduce a connection token unless the proxy story changes.
- Do not bake authentication or workspace identity into the editor image; the proxy is responsible.
- Keep the AS Lite source patches and postMessage handshake unchanged.
- Do not re-verify upstream extension-owned behavior such as redhat.java auto-import, hover, diagnostics, or F12/ctrl-click into WPILib classes in later stages unless an editor or extension version changed. Decision 011 is the evidence record for those checks.
- After modifying code, run `bun run typecheck`, `bun test`, and the relevant `verify:v2:*` script. Update graphify per `AGENTS.md`.
