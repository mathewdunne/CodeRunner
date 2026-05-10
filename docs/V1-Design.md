# FRC Web Simulator V1: Design Document

> Archived historical design. V2 is the current runtime model and source of
> truth; see [`V2-Design.md`](V2-Design.md) before implementing current system
> behavior.

**Status:** V1 implementation baseline  
**Date:** 2026-05-04  
**Audience:** Multiple coding agents implementing the rewrite in coordinated tasks  
**Inputs:** `Project-MVP.md`, `Spike-Multi-Tenancy.md`, `docs/decisions/001-006`, current MVP source, Bun docs, TanStack Start docs

This document is the contract for the V1 rewrite. It should be updated only when a task discovers evidence that changes the design. Non-obvious changes need a new decision log in `docs/decisions/`.

---

## 0. Decisions at a Glance

- **Rewrite shape:** archive the MVP source under `mvp/`, then scaffold V1 at the repo root. Copy proven code deliberately; do not evolve the MVP in place.
- **Language rule:** all V1 non-WPILib code remains TypeScript, but V1 intentionally switches from Node/npm/tsx to **Bun** for package management, script running, and the app runtime.
- **Frontend:** use **React + Vite + Monaco**. Use TanStack Router if route structure becomes useful. Do **not** use TanStack Start for V1 core.
- **Control plane:** one Bun process owns HTTP, WebSockets, static assets, sessions, file APIs, run orchestration, AS Lite routing, LSP proxying, and container lifecycle.
- **Persistence:** project files live on the host filesystem under `data/`; metadata/session/container state lives in SQLite.
- **Containers:** one sim container and one Java LSP container per active workspace. Both mount the same persisted project directory at `/workspace/project`.
- **Routing:** public routes use `/u/<workspaceSlug>/...`. The route is backed by a signed cookie session; query-param identity remains spike-only.
- **AS Lite:** maintain a source-level AdvantageScope Lite patch for injected NT4 endpoints. Use parent-to-iframe `postMessage` in the app and query params only for dev/smoke tests.
- **Resources:** target 10 active students. Queue Gradle build/run work globally. Tear down idle containers while preserving files.
- **Deployment:** one command should stand up the classroom stack on a self-hosted machine with Docker and Bun installed.

---

## 1. Context

The MVP proved the loop that matters:

1. Edit Java in Monaco.
2. Save to a WPILib project.
3. Run Gradle simulation in a container.
4. Expose NT4 telemetry.
5. Display telemetry in AdvantageScope Lite.
6. Stream build/sim logs back to the browser.
7. Provide Java hover, completion, diagnostics, and semantic tokens through Eclipse JDT LS.

The multi-tenancy spike answered the architectural questions that would have forced a late rewrite:

- NT4 should be path-routed through a WebSocket proxy, not exposed as port-per-student in the browser.
- V1 should use per-student sim containers and per-student JDT LS containers.
- Query-param identity worked for the spike, but V1 should use path-prefix workspace identity plus cookies.
- Cold sim readiness was about 10 seconds. Cold LSP bridge startup was a few seconds. The real classroom risk is synchronized Gradle builds, not steady-state sim CPU.
- Ten students likely fit in roughly 12-15.5 GiB for containers before OS/Docker/browser overhead, but the target host must be measured.

V1 is the informed second build. It should be clean enough for a classroom and for future auth/project features, but it is still not a SaaS product.

---

## 2. V1 Goals

V1 must deliver these capabilities on one self-hosted classroom machine:

- Ten students can use the app concurrently without crossing projects, logs, LSP state, or telemetry.
- Each student has a single default WPILib Java command-based project.
- Student projects persist across browser sessions, container rebuilds, and container teardown.
- The editor supports a real multi-file project: file tree, tabs, create/delete/rename, dirty state, auto-save, and basic unsaved-change protection.
- Java LSP works across the project, not just `Robot.java`.
- The edit -> save -> build -> run -> telemetry loop feels at least as good as the MVP.
- AdvantageScope Lite always connects to the correct student's NT4 stream.
- A username-picker auth shape exists and can be replaced by real auth without changing project/session/container contracts.
- A single command starts the V1 dev/classroom stack after setup.
- The operator has enough visibility to restart stuck sessions and understand resource pressure.

---

## 3. Non-goals

V1 does not include:

- OAuth, SSO, roster integration, or password management.
- Multiple projects per student.
- Project template picker.
- Real-time collaborative editing.
- Driver station controls, enable/disable, mode selection, or gamepad input.
- Public-internet deployment, TLS automation, or hardened multi-tenant security.
- Full observability stack.
- Mobile layout.
- A polished build-error parser beyond useful status plus raw Gradle output.
- Shared JDT LS process.
- Anonymous pre-warmed container reassignment unless a later measurement proves it is needed.

---

## 4. Target Architecture

```
Browser
  |
  | HTTP and WS on one origin
  v
+---------------------------------------------------------------+
| Bun control plane                                             |
|                                                               |
|  Router / static assets / AS Lite assets                      |
|  Session manager and workspace resolver                       |
|  File API and project store                                   |
|  Run queue and log streaming                                  |
|  Container orchestrator                                       |
|  NT4 WebSocket proxy                                          |
|  LSP WebSocket proxy                                          |
+---------------------+--------------------+--------------------+
                      |                    |
                      | host filesystem    | SQLite metadata
                      v                    v
              data/users/...           data/app.db
                      |
        bind mount /workspace/project
                      |
      +---------------+----------------+
      |                                |
+-----v------+                  +------v-----+
| Sim        |                  | LSP        |
| container  |                  | container  |
| per        |                  | per        |
| workspace  |                  | workspace  |
+------------+                  +------------+
      |
      | NT4 5810, proxied only by control plane
      v
AdvantageScope Lite iframe receives injected endpoint
```

The control plane is deliberately central. It is the only browser-facing server and the only process that knows how a workspace maps to containers, host ports, project paths, and LSP paths.

---

## 5. Repository Migration and Layout

### 5.1 Archive the MVP first

Task V1-0 starts with an archival move. Use `git mv` for tracked files.

Move MVP-authored source and MVP docs under `mvp/`:

```
mvp/
  apps/
  containers/
  scripts/
  docs/decisions/
  Project-MVP.md
  Spike-Multi-Tenancy.md
  package.json
  package-lock.json
  tsconfig.json
  README.md
```

Do not move generated output:

- `dist/`
- `node_modules/`
- logs and graph output

Keep `vendor/AdvantageScope` at the repo root because V1 still uses the same submodule. Record the pinned submodule SHA in `mvp/README.md` so the MVP archive remains understandable.

After the move, root-level docs are V1-forward:

```
V1-Design.md
docs/decisions/        V1 and later decisions, starting at 007 or with a clear V1 prefix
AGENTS.md              update after V1 tooling lands
README.md              V1 quickstart after V1-1
```

### 5.2 V1 target layout

```
apps/
  control/             Bun control plane: HTTP, WS, sessions, orchestration
  web/                 React + Vite browser IDE shell
containers/
  sim/                 V1 sim image, mounted project at runtime
  lsp/                 V1 JDT LS image and Bun/TS WS bridge
packages/
  contracts/           Shared API schemas, message types, path rules
templates/
  wpilib-java-command/ Source of truth for the starter WPILib project template
scripts/
  build-ascope-lite.ts
  apply-ascope-patches.ts
  dev-v1.ts
  verify-v1-two-user.ts
patches/
  advantagescope/
data/                  gitignored runtime data
vendor/
  AdvantageScope/
```

`packages/` is justified in V1 because the web app, control plane, scripts, and LSP bridge need shared API contracts and path validation. Do not add more packages until two packages really need the code. The Java starter project is a template, not a TypeScript package, so it belongs under `templates/`.

---

## 6. Tooling Decisions

### 6.1 Bun

V1 should use Bun for:

- `bun install`
- `bun run`
- TypeScript script execution without `tsx`
- the control-plane runtime
- the V1 LSP bridge runtime if compatible
- `bun test` for focused unit tests

Keep `tsc --noEmit` for typechecking. Bun runs TypeScript but does not replace TypeScript's checker.

Add:

```
.bun-version
bun.lock
```

Remove `package-lock.json` from the V1 root after the MVP archive move.

Use Bun workspaces:

```json
{
  "workspaces": ["apps/*", "packages/*"]
}
```

Important constraints:

- The AdvantageScope submodule is still an upstream npm project. The V1 AS build script may continue to run `npm install` and `npm run ...` inside `vendor/AdvantageScope` until a Bun-based AS build is proven. That exception is local to vendor build steps.
- Avoid shell-specific package scripts. Put non-trivial orchestration in TypeScript scripts so Windows PowerShell 7 and Linux shells behave the same.
- On Windows, documented shell commands should assume PowerShell 7 (`pwsh`).
- Prefer `Bun.spawn` with fixed argument arrays for Docker/Gradle subprocesses. Do not build shell strings from user input.
- Bun has broad Node API compatibility, but it is not complete. Avoid Node cluster/IPC/socket-handle passing. The current app does not need those APIs.

### 6.2 Backend framework

Use `Bun.serve` directly for V1 control-plane routing and WebSocket upgrades.

Reason:

- The app is mostly custom protocol handling: NT4 proxying, LSP proxying, run-log WebSockets, static AS Lite assets, file APIs, and session checks.
- Bun's native WebSocket server maps well to the route demux work.
- Fastify was a good MVP choice, but V1 should avoid carrying Node-specific server dependencies into a Bun-first app.

If route tables become too hand-rolled, Hono is the preferred small framework because it supports Bun and Web-standard handlers. Do not add Hono in V1-1 unless the direct `Bun.serve` code is already getting unclear.

### 6.3 Frontend framework

Use React + Vite + Monaco.

Use these supporting libraries only when they earn their keep:

- `@tanstack/react-router` for route structure if settings/project/session routes grow beyond one screen.
- `@tanstack/react-query` for server state if manual fetch/cache/invalidation becomes noisy.
- A small file-tree component only if it integrates cleanly with keyboard and rename/create/delete flows. A custom tree is acceptable for V1.

Do not use TanStack Start for V1 core.

Why:

- This app is a private, authenticated, browser-heavy IDE. It has no SEO requirement and little benefit from SSR.
- Monaco, AS Lite, WebSockets, and local editor state are client-first concerns.
- TanStack Start is isomorphic by default, which creates extra boundaries for browser-only code.
- Start's server functions/routes do not remove the need for the custom Bun control plane that owns Docker, WebSocket proxying, and session/container state.
- Start SPA mode is possible, but once SSR is disabled most of the value over React + Vite + TanStack Router disappears.

Reconsider TanStack Start later if the product gains substantial non-IDE pages, account flows, docs, or server-rendered content.

### 6.4 Validation and shared contracts

Use a runtime schema library in `packages/contracts` for:

- route params
- API request bodies
- API responses
- WebSocket message frames
- safe project paths

Default choice: Zod. It is boring, well-known, and good enough. If another schema library is chosen, record the reason in a decision log before implementation.

---

## 7. Domain Model

### 7.1 IDs

- `userId`: internal stable ID, random or SQLite integer/string. Never derived from display name alone.
- `workspaceId`: internal stable ID for a user's default project workspace.
- `workspaceSlug`: browser route slug, URL-safe. V1 may use sanitized usernames for readability, but the database remains the source of truth.
- `sessionId`: random signed cookie value. Not visible in route paths.
- `containerName`: derived from `workspaceId`, not from raw display name.

Allowed route slugs:

```
^[a-zA-Z0-9_-]{1,40}$
```

Container names:

```
frc-v1-sim-<workspaceId>
frc-v1-lsp-<workspaceId>
```

If `workspaceId` can contain anything outside Docker's safe name set, store a separate `containerSlug`.

### 7.2 SQLite tables

Minimum V1 metadata:

- `users(id, display_name, slug, created_at, last_seen_at)`
- `workspaces(id, user_id, slug, project_path, created_at, last_accessed_at)`
- `sessions(id, user_id, created_at, last_seen_at, expires_at)`
- `container_leases(workspace_id, sim_container, lsp_container, sim_port, lsp_port, state, last_used_at, created_at)`
- `run_jobs(id, workspace_id, state, requested_at, started_at, finished_at, exit_code, log_path)`

SQLite migrations live as plain SQL files under `apps/control/migrations/` or `packages/contracts/migrations/` once shared. The database includes a `schema_migrations` table that records migration name, checksum, and applied timestamp. On startup, the control plane refuses to run if any applied migration's recorded checksum no longer matches its on-disk file; unapplied migrations may be edited freely until they are run. The control plane auto-runs pending migrations on startup in V1 because there is only one process and one local database, but every applied migration must be logged. Also provide `bun run migrate` and `bun run migrate:status` so operators and agents can run or inspect migrations explicitly. Do not hide schema changes in ad hoc startup code outside migration files.

### 7.3 Filesystem layout

Runtime data is gitignored:

```
data/
  app.db
  users/
    <workspaceId>/
      project/          authoritative student work; backup and restore this
      jdtls-data/       regenerable LSP cache; safe to reset
      home/             regenerable tool cache; safe to prune when containers are stopped
      logs/
        runs/           transient run history; safe to prune; not backed up
  backups/
    YYYY-MM-DD/         project snapshots only; exclude home/ and jdtls-data/
```

The mounted project path is:

```
data/users/<workspaceId>/project  ->  /workspace/project
```

The JDT LS data path is:

```
data/users/<workspaceId>/jdtls-data  ->  /workspace/jdtls-data
```

The container home path is:

```
data/users/<workspaceId>/home  ->  /home/frc
```

First login copies the starter template from `templates/wpilib-java-command/` into the workspace project path. Workspace creation also creates `jdtls-data/`, `home/`, and `logs/runs/`; `home/` starts empty, uses mode `0700` where the host supports POSIX modes, and is owned by the configured `FRC_UID:FRC_GID` on Linux. Tooling populates `home/` on first Gradle or LSP run.

### 7.4 Template provenance

The committed starter template under `templates/wpilib-java-command/` is the source of truth for new workspaces.

V1-0 must create it from the WPILib 2026 Java command-based template and MVP project evidence:

- Source install path on the author's machine: `C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\`.
- WPILib/GradleRIO version: document the exact version in `templates/wpilib-java-command/README.md`.
- Keep the Gradle wrapper, `build.gradle`, `settings.gradle`, `gradle.properties`, `.wpilib` preferences required by GradleRIO, `vendordeps/WPILibNewCommands.json`, and `src/main/java/frc/robot/**`.
- Keep the MVP telemetry example only if it remains useful as the first classroom starter program.
- Remove machine-specific IDE metadata and any local absolute paths.
- The sim and LSP images may copy this template only for cache priming. They must not become the source of truth for student files.

---

## 8. Public Routing Contract

### 8.1 Browser routes

```
GET  /                         login or redirect to current workspace
POST /login                    username picker submit
POST /logout                   clear session cookie
GET  /u/:workspaceSlug/         web app shell
GET  /u/:workspaceSlug/assets/* web app assets if needed
GET  /scope/*                  shared AS Lite static assets
```

The app shell should be route-prefix aware. It should not assume it lives at `/`.

### 8.2 API routes

All workspace APIs are under:

```
/u/:workspaceSlug/api/...
```

Minimum V1 routes:

```
GET    /session
POST   /heartbeat
GET    /project/tree
GET    /files?path=<project-relative-path>
PUT    /files?path=<project-relative-path>
POST   /files                  create file or directory
PATCH  /files/rename
DELETE /files?path=<project-relative-path>
POST   /run                    optional HTTP run request if WS is not open
POST   /run/stop
GET    /containers/status
```

File path rules:

- Paths are project-relative POSIX paths in API contracts.
- Reject absolute paths, drive letters, backslashes, `..`, empty segments, NUL, and control characters.
- Resolve on the server and verify the final path stays under the workspace project root.
- V1 editable allowlist:
  - `src/main/java/**`
  - `src/test/java/**`
  - `src/main/deploy/**`
  - optionally `vendordeps/*.json` after a specific UI exists
- V1 read-only allowlist:
  - `build.gradle`
  - `settings.gradle`
  - `gradle.properties`
  - `.wpilib/**`
- Hide or block:
  - `.gradle/**`
  - `build/**`
  - `gradle/wrapper/**`
  - generated logs and temporary files

File API semantics:

```ts
type WriteFileRequest = {
  contents: string;
};

type CreateFileRequest =
  | { kind: "file"; path: string; contents?: string }
  | { kind: "directory"; path: string };

type RenameFileRequest = {
  from: string;
  to: string;
};
```

- `GET /files?path=X` returns file text. Directories use `/project/tree`, not `GET /files`.
- `PUT /files?path=X` writes full file contents and creates the file if missing. Parent directories must already exist.
- `POST /files` creates a file or directory and fails if the path already exists.
- `PATCH /files/rename` moves one file or directory and fails if `to` exists.
- `DELETE /files?path=X` deletes a file. It deletes directories only when empty unless a future explicit recursive option is added.
- All write APIs return the updated tree node or enough metadata for the client to update the tree without a full refresh.

### 8.3 WebSocket routes

```
WS /u/:workspaceSlug/ws/run
WS /u/:workspaceSlug/ws/lsp
WS /u/:workspaceSlug/sim/nt4
GET /u/:workspaceSlug/sim/alive
```

The control plane authenticates and resolves `workspaceSlug` before upgrading. If the workspace is not allowed for the cookie session, the socket is closed before proxying.

### 8.4 Run WebSocket messages

Server-to-client:

```ts
type RunServerMessage =
  | { type: "hello"; runId: string; queueDepth: number }
  | {
      type: "status";
      status: "queued" | "stopping" | "building" | "running" | "failed" | "stopped";
      queueDepth?: number;
      queuePosition?: number;
    }
  | { type: "queue"; queueDepth: number; queuePosition: number }
  | { type: "log"; stream: "stdout" | "stderr" | "sim"; line: string }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "error"; message: string };
```

Client-to-server:

```ts
type RunClientMessage =
  | { type: "start" }
  | { type: "stop" };
```

One workspace can have only one active run. A new `start` cancels or supersedes the previous run for that workspace. `queueDepth` and `queuePosition` are present on `status: "queued"` messages and on later `queue` updates.

---

## 9. Control Plane Components

### 9.1 Router

Responsibilities:

- Serve the login page, app shell, Vite-built web assets, and AS Lite assets.
- Resolve workspace route params.
- Enforce session cookie access.
- Dispatch HTTP API routes.
- Upgrade and proxy WebSockets for run, LSP, and NT4.
- Provide health and operator status endpoints.

Inputs:

- HTTP requests
- WebSocket upgrades
- `data/app.db`
- configured host/port and data directory

Outputs:

- static assets
- API responses
- proxied WebSocket bytes
- structured logs

Key decisions:

- One origin for the browser avoids cross-origin header drift.
- All public workspace routes are path-prefixed.
- The router is a Bun process, not nginx/Caddy, because session/container routing is application state.

### 9.2 Session manager

Responsibilities:

- Render/handle username picker.
- Create or load the V1 user/workspace.
- Set a signed, HttpOnly, SameSite=Lax cookie.
- Resolve current user from cookie.
- Check that the cookie user owns the requested workspace.
- Update `last_seen_at` and `last_accessed_at`.

V1 cookie:

```
frc_v1_session=<sessionId>.<signature>
```

V1 username picker rules:

- Display name can be friendly.
- Slug is sanitized and collision-handled.
- If a slug already exists, the user should be shown a clear "that name is taken in this classroom" message unless the same session owns it.

Future auth:

- OAuth/SSO replaces `/login` and session creation.
- The workspace/project/container contracts remain unchanged.

Heartbeat:

- The web shell sends `POST /u/:workspaceSlug/api/heartbeat` every 60 seconds while the tab is loaded.
- Any API call, run WebSocket message, LSP WebSocket activity, or successful heartbeat updates `last_seen_at`.
- `pagehide` should send a best-effort final heartbeat with a `closing` flag, but idle teardown must not rely on it.
- A workspace is considered browser-inactive after 5 minutes without heartbeat or other activity.
- Browser-inactive is not the same as container-idle. Container stop timers in the orchestrator still apply so a throttled background tab does not immediately lose its sim/LSP containers.

### 9.3 Project store

Responsibilities:

- Create workspace project directories from the template.
- Read, write, create, delete, and rename project files.
- Build project trees for the web app.
- Enforce path allowlists.
- Write files atomically where practical.
- Keep project files independent of container lifecycle.

Key decision:

- The source of truth is the host filesystem, not `docker exec cat > file`.
- The sim and LSP containers see the project via bind mount.

### 9.4 Container orchestrator

Responsibilities:

- Build or verify required images.
- Create, start, stop, and remove per-workspace sim/LSP containers.
- Allocate loopback host ports for sim NT4 and LSP bridge.
- Run containers with a UID/GID that can safely write the host data directory.
- Apply memory limits, CPU limits if needed, labels, and mounts.
- Reconnect to existing containers after control-plane restart.
- Tear down idle containers without deleting project data.

Container labels:

```
frc-sim.managed=true
frc-sim.version=v1
frc-sim.role=sim | lsp
frc-sim.workspace=<workspaceId>
```

Default lifecycle:

- Ensure containers when a workspace app is opened.
- Keep containers while the browser is active.
- Mark idle after 15 minutes without app heartbeat or run activity.
- Stop idle after 30 minutes.
- Remove stopped managed containers during daily cleanup if they can be recreated.

Port allocation:

- Allocate ports from configured loopback-only ranges:
  - `SIM_PORT_RANGE=25810-25899`
  - `LSP_PORT_RANGE=30003-30102`
- Choose the lowest free port in the range, store it in `container_leases`, and bind only to `127.0.0.1`.
- On restart, inspect Docker first. If a managed container is running, use Docker's actual published port and update SQLite if it differs.
- If SQLite records a port but no matching container exists, check whether the port is still free before reusing it; otherwise allocate the next free port.
- If no port is available, workspace startup fails with an operator-visible resource error.

Restart reconciliation:

- Docker labels are runtime truth; SQLite is cached intent and history.
- Labeled container exists and SQLite row exists: adopt the container, update state and published ports from Docker.
- Labeled container exists and SQLite row is missing: adopt it only if its workspace still exists; otherwise stop/remove it as orphaned managed infrastructure.
- SQLite row exists and container is gone: mark the lease stopped, clear stale ports, and recreate on next ensure.
- Container exists but has the wrong role/workspace label or is published on a non-loopback host address: stop it and recreate from SQLite intent.
- Never delete project files during reconciliation.

UID/GID policy:

- V1 images create a non-root `frc` user.
- On Linux, build or run images with `FRC_UID`/`FRC_GID` matching the host user that owns `data/`; runtime commands include `--user <FRC_UID>:<FRC_GID>`.
- On Docker Desktop/Windows, defaults may be used, but V1-4 must still verify the control plane can read, write, and delete files produced by Gradle and JDT LS.
- Gradle and JDT LS writable home/cache paths must live under the mounted `data/users/<workspaceId>/home`, not under `/root`.

Prewarming:

- Do not implement anonymous pre-warmed pools first. Bind mounts make anonymous reassignment awkward.
- Implement a `bun run prewarm -- --user alice --user bob` or roster-based prewarm command later if class-start latency matters.

### 9.5 Run service

Responsibilities:

- Maintain a global build/run queue.
- Enforce one active run per workspace.
- Stop the current sim before a new run.
- Start the sim through container scripts.
- Stream Gradle and sim logs.
- Detect successful NT4 readiness.
- Persist run logs under `data/users/<workspaceId>/logs/runs/`.

Default limits:

- Global concurrent builds: 2 until target-host measurements say otherwise.
- Per-workspace concurrent builds: 1.
- Build timeout: 90 seconds for V1 starter projects.
- Sim startup timeout: 30 seconds after build succeeds.

Run state:

```
idle -> queued -> stopping -> building -> running
                    |            |
                    v            v
                  failed       failed
```

The UI should show queue position when status is `queued`.

### 9.6 NT4 proxy

Responsibilities:

- Serve `/u/:workspaceSlug/sim/alive`.
- Proxy `/u/:workspaceSlug/sim/nt4` to the workspace sim container's NT4 endpoint.
- Preserve the NT4 WebSocket subprotocol.
- Close both sides when either side closes.

Upstream target:

```
ws://127.0.0.1:<allocatedSimPort>/nt/AdvantageScopeLite
```

For a future containerized control plane, this may become:

```
ws://frc-v1-sim-<workspaceId>:5810/nt/AdvantageScopeLite
```

Keep that switch behind an orchestrator target resolver.

### 9.7 LSP proxy

Responsibilities:

- Ensure the LSP container is running before proxying.
- Proxy browser LSP WebSocket bytes to the per-workspace LSP bridge.
- Restart the LSP container when the bridge is stuck or exits.

Upstream target:

```
ws://127.0.0.1:<allocatedLspPort>/jdtls
```

The browser never connects to raw per-user host ports.

### 9.8 Operator endpoints

Minimum V1 operator surface:

```
GET  /admin/status
POST /admin/workspaces/:workspaceId/restart-sim
POST /admin/workspaces/:workspaceId/restart-lsp
POST /admin/workspaces/:workspaceId/reset-lsp-data
POST /admin/workspaces/:workspaceId/stop-containers
```

Protect these with a local operator token or localhost-only access in V1. Do not expose them to students.

`reset-lsp-data` stops the LSP container, deletes `data/users/<workspaceId>/jdtls-data`, recreates the directory with the configured UID/GID ownership, and starts the LSP container again. It must never touch `project/`.

---

## 10. Container Design

### 10.1 Sim image

The V1 sim image should keep the good MVP decisions:

- JDK 17.
- Ubuntu/glibc base, not Alpine.
- Non-root `frc` runtime user with configurable UID/GID.
- Gradle/WPILib dependencies primed during image build.
- No SimGUI or DriverStation sim extension.
- `tini` or equivalent init/reaper.
- `start-sim.sh` and `stop-sim.sh`.

Changes from MVP:

- The runtime project is mounted at `/workspace/project`.
- The image may include the starter template only for cache priming and fallback diagnostics.
- The image should not treat baked `Robot.java` as source of truth.
- Startup should tolerate an empty mount only long enough to report a clear error.

Runtime command shape:

```
docker run -d
  --name frc-v1-sim-<workspaceId>
  --label frc-sim.managed=true
  --label frc-sim.role=sim
  --label frc-sim.workspace=<workspaceId>
  --mount type=bind,src=<projectPath>,dst=/workspace/project
  --mount type=bind,src=<homePath>,dst=/home/frc
  -p 127.0.0.1:<simPort>:5810
  --user <FRC_UID>:<FRC_GID>
  --memory=<simMemoryLimit>
  frc-sim:v1
```

### 10.2 LSP image

The V1 LSP image should:

- Install Eclipse JDT LS.
- Include Bun if the bridge runs on Bun.
- Run as the same non-root UID/GID policy as the sim image.
- Prime Gradle/WPILib dependencies during image build.
- Mount the project at `/workspace/project`.
- Mount JDT LS data at `/workspace/jdtls-data`.
- Mount the workspace home at `/home/frc`.
- Listen on container port `30003` for `/jdtls`.

First implementation should try the current bridge shape under Bun. If `vscode-ws-jsonrpc` or stream behavior does not work cleanly under Bun, replace it with a small Bun-native WebSocket-to-stdio JSON-RPC bridge. Do not reintroduce Node unless a decision log documents the blocker.

Runtime command shape:

```
docker run -d
  --name frc-v1-lsp-<workspaceId>
  --label frc-sim.managed=true
  --label frc-sim.role=lsp
  --label frc-sim.workspace=<workspaceId>
  --mount type=bind,src=<projectPath>,dst=/workspace/project
  --mount type=bind,src=<jdtlsDataPath>,dst=/workspace/jdtls-data
  --mount type=bind,src=<homePath>,dst=/home/frc
  -p 127.0.0.1:<lspPort>:30003
  --user <FRC_UID>:<FRC_GID>
  --memory=<lspMemoryLimit>
  frc-lsp:v1
```

---

## 11. AdvantageScope Lite

V1 cannot rely on AS Lite's MVP behavior of `window.location.hostname:5810`. Multi-tenancy requires injected endpoints.

### 11.1 Patch strategy

Maintain a source-level patch under:

```
patches/advantagescope/001-lite-nt4-endpoint-injection.patch
```

Patch target areas:

- `vendor/AdvantageScope/src/hub/hub.ts`
- `vendor/AdvantageScope/src/hub/dataSources/nt4/NT4.ts`

Patch behavior:

- Lite mode can accept an endpoint object:
  - alive URL
  - WebSocket URL
  - app name, default `AdvantageScopeLite`
- Endpoint can arrive by `postMessage`.
- Query params can override for smoke tests.
- Embedded V1 iframes load AS Lite as `/scope/?frcEndpoint=postMessage`. In this mode, the patch must defer `checkLiveAutoStart()` until the endpoint message arrives and must not fallback to hostname/5810 before that message.
- Standalone AS Lite without `frcEndpoint=postMessage` falls back to upstream Lite hostname/5810 behavior so local AS testing remains possible.
- Query-param endpoint override is allowed for smoke tests and should start immediately without waiting for postMessage.
- The patch must reach both the HTTP alive probe path (`connectOnAlive()`) and the WebSocket dial path (`ws_connect()`).
- The patched AS Lite sends an acknowledgement message to the parent when it has accepted config.
- If an embedded iframe does not receive endpoint config within 10 seconds, it should show a disconnected/error state rather than silently connecting to the wrong host.

Parent-to-iframe message:

```ts
type ScopeConfigMessage = {
  type: "frc-sim:set-nt4-endpoint";
  endpoint: {
    aliveUrl: string;
    websocketUrl: string;
  };
};
```

Iframe-to-parent acknowledgement:

```ts
type ScopeReadyMessage = {
  type: "frc-sim:nt4-endpoint-ready";
};
```

### 11.2 Build pipeline

Keep V1 scripts:

```
bun run build:ascope
bun run verify:ascope
```

`build:ascope`:

1. Verifies submodule.
2. Applies source patch.
3. Runs upstream AdvantageScope install/build commands.
4. Resolves Windows symlink placeholders as the MVP script did.
5. Writes `dist/advantagescope/`.

`verify:ascope`:

- Starts a tiny test NT4 endpoint or uses a running sim.
- Serves AS Lite through the control plane.
- Confirms the injected alive URL is fetched.
- Confirms the injected WebSocket URL is dialed.

Submodule bumps must run AS Lite verification before merge.

### 11.3 Sub-path hosting contract

AS Lite was only proven at the web root in the MVP. V1 serves it from `/scope/`, so V1-6 must verify sub-path hosting before relying on it.

The control plane must serve all AS Lite runtime assets under `/scope/`, including:

- `/scope/`
- `/scope/assets`
- `/scope/assets/<name>/<file>`
- `/scope/bundles/**`
- `/scope/www/**`
- any fonts, wasm, images, models, or docs assets referenced by the bundle

If any upstream HTML or bundle path is root-absolute, V1-6 must either add a safe rewrite in the control plane or include a small `<base>`/path patch in the AS Lite patch series. The chosen fix must be covered by `verify:ascope`.

---

## 12. Web Shell

### 12.1 Product shape

The first screen is the IDE, not a landing page.

Primary layout:

- left: file tree
- center: Monaco editor with tabs
- right: AdvantageScope Lite iframe
- bottom: console/run panel

Expected controls:

- Run
- Stop
- save status
- container/LSP/sim status
- active username/workspace indicator
- logout

### 12.2 Editor model

Use one Monaco model per open file:

```
file:///workspace/project/<project-relative-path>
```

The browser's file URI must match the path JDT LS sees inside its container.

Open-file behavior:

- Fetch file text through `GET /files`.
- Create Monaco model with language inferred from path.
- Send `textDocument/didOpen` to LSP for Java files.

Edit/save behavior:

- Track dirty state per model.
- Auto-save after a short debounce, around 500 ms.
- Run flushes pending saves before entering the build queue.
- Failed saves keep the model dirty and show a clear status.

Create/delete/rename:

- Update the host filesystem through API.
- Update open models.
- Notify LSP with file operation notifications when supported.
- Fall back to didClose/didOpen if needed.

### 12.3 AS Lite iframe

The iframe source is shared:

```
/scope/?frcEndpoint=postMessage
```

The parent sends the per-workspace endpoint after iframe load:

```
aliveUrl:     /u/<workspaceSlug>/sim/alive
websocketUrl: ws(s)://<host>/u/<workspaceSlug>/sim/nt4
```

The web shell should show a small "scope connecting" status until acknowledgement or timeout.

### 12.4 Status model

The UI should distinguish:

- file save status
- LSP status
- sim/container status
- run/build status
- AS Lite connection status if exposed

Do not collapse all of these into one `idle/building/running/error` label. That was enough for MVP; it will mislead students in V1.

---

## 13. Java LSP

V1 uses one JDT LS container per active workspace.

Browser responsibilities:

- Connect to `/u/:workspaceSlug/ws/lsp`.
- Initialize with:
  - `rootUri: file:///workspace/project`
  - workspace folder `file:///workspace/project`
- Send didOpen/didChange/didClose for Java models.
- Register hover, completion, diagnostics, and semantic token providers.
- Handle LSP reconnect without losing open editor models.

Control-plane responsibilities:

- Ensure LSP container exists.
- Proxy bytes.
- Restart or recreate a stuck LSP container on operator action or health failure.

LSP container responsibilities:

- Run the bridge.
- Spawn Eclipse JDT LS.
- Use `/workspace/jdtls-data` for per-workspace indexes.

Known risk:

- The spike verified per-user initialization/diagnostics but scripted completions were inconclusive. V1 must verify browser completions for at least two simultaneous students before calling LSP done.

---

## 14. Resource Budget and Lifecycle

### 14.1 Initial sizing

Spike extrapolation for 10 active students:

- Sim containers: about 7-8.5 GiB.
- Active JDT LS containers: about 4.5-7 GiB.
- Total containers: about 12-15.5 GiB before OS/Docker/browser overhead.

V1 target host recommendation:

- 32 GiB RAM preferred.
- 16 GiB may work only with conservative concurrency, shorter idle timeouts, and fewer fully active LSP sessions.
- 6+ CPU cores preferred because synchronized Gradle builds are bursty.

Default memory caps to start:

- sim: `--memory=1536m`
- lsp: `--memory=1536m`

Keep these config-driven:

```
SIM_MEMORY_LIMIT=1536m
LSP_MEMORY_LIMIT=1536m
RUN_CONCURRENCY=2
IDLE_STOP_MINUTES=30
```

### 14.2 Lifecycle timeline

Login:

1. User submits display name.
2. Session cookie is set.
3. Workspace is loaded or created.
4. Project template is copied if this is the first login.
5. Browser redirects to `/u/<workspaceSlug>/`.

Open IDE:

1. Web shell loads.
2. App fetches `/api/session` and `/api/project/tree`.
3. Control plane ensures containers in the background.
4. Editor opens default file, likely `src/main/java/frc/robot/Robot.java`.
5. LSP connects when ready.
6. AS Lite iframe receives NT4 endpoint.

Run:

1. Web shell flushes saves.
2. Run WS sends `start`.
3. Run enters queue.
4. Control plane stops old sim.
5. Control plane starts sim script.
6. Logs stream to browser and file.
7. Status flips to `running` when NT4 readiness appears.
8. AS Lite reconnects to the workspace's NT4 stream.

Idle:

1. Browser heartbeat stops or no activity is observed.
2. Workspace marked idle.
3. Containers stop after idle timeout.
4. Project files and JDT LS data remain.
5. Return to the app restarts containers.

---

## 15. Failure Modes

| Failure | Detection | User behavior | Recovery |
| --- | --- | --- | --- |
| Sim container OOM | Docker exit reason or missing health | Run status becomes failed, console explains sim exited | Recreate sim container; keep project files |
| LSP container OOM/stuck | LSP WS closes or health timeout | Editor still works; LSP status shows unavailable | Recreate LSP container and reconnect |
| Gradle build timeout | Run timer exceeds limit | Run status failed with timeout log | Stop sim process, leave files untouched |
| Build queue saturated | Queue depth above threshold | Student sees queued status and position | Operator can raise/lower concurrency |
| NT4 proxy target unavailable | Alive check fails or WS upstream error | AS Lite status shows reconnecting/unavailable | Ensure/restart sim container |
| JDT LS data corrupted | Repeated LSP crash, stale lock, or diagnostics never settle after restart | Editor still works; LSP status shows unavailable or degraded | Operator runs `reset-lsp-data`; data regenerates from project sources |
| Control plane crash | Process exit | Browser disconnects; containers may continue | Restart control plane, reload leases from Docker labels and SQLite |
| Host disk full | File writes or logs fail | Save/run blocked with clear error | Operator prunes run logs and regenerable `home/` or `jdtls-data/` caches for stopped workspaces; never delete `project/` |
| AS Lite patch drift | Build or smoke test fails after submodule bump | No release | Fix patch before bump lands |
| Bad path request | Contract validation fails | 400/403, no filesystem write | No recovery needed |

Every recovery path must preserve `data/users/<workspaceId>/project`.

---

## 16. Security Posture for V1

V1 is intended for a trusted classroom LAN, not the public internet.

Required anyway:

- Signed HttpOnly session cookie.
- SameSite=Lax cookie.
- No API access to workspaces not owned by the session.
- Strict path validation for all file operations.
- Docker container names and command args derived from validated IDs only.
- Docker commands use fixed argv arrays, not shell-built strings.
- Per-container memory caps.
- Admin/operator endpoints protected by a local token or localhost-only binding.

Explicitly deferred:

- TLS.
- OAuth.
- Per-student passwords.
- Strong container sandboxing beyond Docker defaults.
- Audit log suitable for public deployment.

---

## 17. Verification Strategy

V1 should have more verification than the MVP because multiple agents will touch shared contracts.

Required commands:

```
bun run typecheck
bun test
bun run verify:v1:two-user
```

Suggested tests:

- `packages/contracts`: path validator, slug validator, API schemas.
- `apps/control`: session ownership checks, project path resolution, run queue behavior.
- `scripts`: container name/port allocation with mocked Docker calls.

Two-user smoke test:

1. Build V1 sim and LSP images.
2. Start control plane.
3. Create `alice` and `bob`.
4. Confirm each has a separate project directory.
5. Edit Bob's file and confirm Alice is unchanged.
6. Run Alice and Bob, with run queue if concurrency is 1.
7. Confirm each NT4 route connects to the right container.
8. Confirm browser LSP diagnostics/completions work for both sessions.

Manual classroom smoke:

- Start 3-5 browsers or profiles.
- Open separate users.
- Edit/run each.
- Watch host RAM/CPU.
- Stop browsers and verify idle teardown.
- Return as the same users and verify files persist.

---

## 18. Implementation Phases

Each task must have a definition of done that can be verified without future tasks. Do not merge a task that knowingly breaks an earlier task's definition of done.

### V1-0: Archive MVP and scaffold V1 root

Deliverables:

- MVP source moved under `mvp/`.
- Root `package.json` converted to Bun workspaces.
- `apps/control`, `apps/web`, `packages/contracts`, and script placeholders created.
- `templates/wpilib-java-command/` extracted, committed, and documented with WPILib/GradleRIO provenance.
- `README.md` updated with V1 status and MVP archive pointer.
- `AGENTS.md` stack rule updated for V1 Bun usage.

Definition of done:

- `bun install` succeeds.
- `bun run typecheck` succeeds with placeholder packages.
- MVP archive has enough docs to run the old loop manually if needed.

### V1-1: Contracts, storage, and session skeleton

Deliverables:

- `packages/contracts` schemas for IDs, paths, file APIs, and run messages.
- SQLite initialization and migration script.
- Username picker flow.
- Signed cookie session.
- Workspace creation from project template.
- `/u/:workspaceSlug/` route serving a placeholder app.

Definition of done:

- Creating `alice` writes a user, workspace, session, and project directory.
- Reload with the cookie returns to Alice's workspace.
- Bad slugs and invalid paths are rejected by tests.

### V1-2: Control-plane routing and static shell

Deliverables:

- Bun `Bun.serve` router with workspace auth checks.
- React + Vite shell served under `/u/:workspaceSlug/`.
- `/api/session` and `/api/project/tree`.
- Heartbeat endpoint for idle tracking.

Definition of done:

- Alice and Bob can load separate placeholder workspaces in different browser profiles.
- API access to another workspace is rejected.
- `bun run typecheck` and route/session tests pass.

### V1-3: Project store and multi-file editor

Deliverables:

- File tree API.
- Read/write/create/delete/rename APIs.
- Monaco multi-model editor, tabs, dirty state, auto-save.
- Path allowlist enforced.

Definition of done:

- Alice can create `subsystems/ExampleSubsystem.java`, edit it, reload, and see it persist.
- Bob cannot read or mutate Alice's files.
- Hidden/generated paths are rejected.

### V1-4: V1 sim image and container orchestrator

Deliverables:

- V1 sim Dockerfile with mounted project support.
- Container lease table.
- Docker CLI orchestration through Bun.
- Loopback port allocation.
- UID/GID ownership strategy for Linux and Docker Desktop.
- Sim status endpoint.

Definition of done:

- Opening Alice's workspace creates/starts Alice's sim container with Alice's project bind-mounted.
- Stopping/removing the container does not delete Alice's project.
- Control-plane restart rediscovers the managed container from labels and SQLite.
- Files created by Gradle in the bind mount can be read and deleted by the control plane.

### V1-5: Run queue and log streaming

Deliverables:

- `/ws/run` protocol.
- Global build concurrency limit.
- Per-workspace run replacement/stop.
- Persistent run logs.
- UI run/stop controls and queue/build/running statuses.

Definition of done:

- Alice can edit, run, see Gradle/sim logs, and reach `running`.
- A syntax error shows raw build output and recovers after fix.
- With concurrency set to 1, Alice and Bob runs queue predictably.

### V1-6: NT4 route and AS Lite source patch

Deliverables:

- AS Lite source patch for endpoint injection.
- Build script applies patch and stages AS Lite.
- Sub-path smoke serving the AS Lite bundle from `/scope/`.
- Control-plane `/scope/` static serving.
- `/u/:workspaceSlug/sim/alive` and `/u/:workspaceSlug/sim/nt4` proxy routes.
- Web shell iframe postMessage config.

Definition of done:

- Alice and Bob AS Lite iframes show their own NT4 streams.
- The AS Lite smoke test proves injected endpoint usage.
- The patch verifies both alive-probe and WebSocket endpoint paths after a clean submodule rebuild.
- Embedded mode defers auto-start until postMessage config arrives; standalone mode still supports hostname/5810 fallback.
- Submodule patch application is repeatable from a clean checkout.

### V1-7: V1 LSP container and project-wide Java LSP

Deliverables:

- V1 LSP image with mounted project and per-workspace data.
- LSP bridge running under Bun or a documented fallback.
- Control-plane LSP proxy.
- Web client supports multiple Java files.
- File operation notifications wired for create/delete/rename.

Definition of done:

- Alice and Bob both get hover/completion/diagnostics in separate workspaces.
- Creating a new Java class appears in completions or diagnostics without restarting the whole app.
- Breaking Bob's project does not affect Alice's LSP.
- Files created by JDT LS under `jdtls-data/` and `home/` can be read and deleted by the control plane; `reset-lsp-data` succeeds against a populated LSP container.

### V1-8: Idle teardown, recovery, and operator controls

Deliverables:

- Browser heartbeat.
- Idle stop/remove policy.
- Operator status page/API.
- Restart sim/LSP actions.
- `reset-lsp-data` endpoint and operator status hook.
- Cleanup script for old stopped containers.

Definition of done:

- Idle containers stop after configured timeout.
- Returning user keeps files and gets new containers.
- Operator can restart one student's LSP without affecting another student.
- Operator can recover Bob's stuck LSP via `reset-lsp-data` without affecting Alice or deleting Bob's project.

### V1-9: Resource tuning and classroom runbook

Deliverables:

- Configurable memory/concurrency limits.
- `verify:v1:two-user` and a 3-user classroom smoke script.
- Runbook for setup, start, stop, backup, restore, cache cleanup, and common failures. Backups include `project/` only and exclude regenerable `home/`, `jdtls-data/`, and `logs/`.
- Host sizing notes updated with real measurements.

Definition of done:

- On the target host, 3 active users are measured through edit/run/LSP/AS Lite.
- Extrapolation to 10 is updated with real numbers.
- Operator can stand up the app from a clean machine using documented commands.

### V1-10: V1 acceptance pass

Deliverables:

- Bug fixes from full classroom smoke.
- README and AGENTS finalized for V1.
- Decision logs complete.

Definition of done:

- Ten simulated or real students can log in, edit, run, see telemetry, and retain projects.
- No cross-talk in files, logs, LSP, or NT4.
- Idle teardown and return work.
- One full classroom session runs without operator intervention.

---

## 19. V1 Definition of Done

All true on the target host:

- Ten students can log in concurrently.
- Each student has a persistent multi-file WPILib Java project.
- File operations are isolated by workspace.
- Java LSP works across files for each active student.
- Run/build output streams to the right browser.
- AdvantageScope Lite shows the right student's telemetry.
- Synchronized runs queue instead of overwhelming the host.
- Idle users release containers.
- Returning users keep their work.
- The operator can restart a stuck sim or LSP without deleting project files.
- One command starts the app after setup.
- The app survives one classroom session without manual intervention.

---

## 20. Open Questions

Resolve before or during the named task:

- **Target host specs:** required by V1-9. Need actual RAM, CPU, disk, OS, and whether Docker runs through Docker Desktop or native Linux.
- **Bun LSP bridge compatibility:** resolve in V1-7. Try current bridge under Bun first; replace bridge if needed.
- **AS Lite upstream patchability:** resolve in V1-6. If source patch is larger than expected, document the patch surface and keep it isolated.
- **Roster prewarm:** resolve after V1-8 measurements. Do not build anonymous prewarm pools before evidence says they matter.
- **Admin protection:** decide token vs localhost-only in V1-8 based on how the classroom host is accessed.
- **Linux target UID/GID:** required by V1-4. Confirm the host user that owns `data/` before building/running V1 images on native Linux.

---

## 21. Rules for Agents

- Read this document before implementing any V1 task.
- Read `mvp/docs/decisions/` when copying MVP behavior.
- Keep task boundaries intact. Do not add future-task features early unless the current contract would otherwise be wrong.
- Update `packages/contracts` before changing API shapes.
- Add or update a decision log for non-obvious architecture/tooling changes.
- Preserve student data under `data/users/<workspaceId>/project`.
- Do not use query-param user identity in V1 production routes.
- Do not expose per-user sim or LSP ports directly to the browser.
- Keep AS Lite patch source-level and repeatable.
- After modifying code files, run the repo's required checks and update graphify per `AGENTS.md`.

---

## 22. Research Notes

Checked on 2026-05-04:

- Bun supports workspaces, native TypeScript execution, a package manager, a test runner, `Bun.serve`, and WebSockets. Its Node compatibility is broad but still has documented gaps, so V1 should prefer Bun-native server/spawn APIs where practical. Sources: [Bun overview](https://bun.sh/docs), [Bun workspaces](https://bun.sh/docs/pm/workspaces), [Bun Node compatibility](https://bun.sh/docs/runtime/nodejs-compat), [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets).
- TanStack Start supports full-stack React apps and SPA mode, but its core execution model is isomorphic by default. That is not a strong fit for a Monaco/AS Lite/WebSocket-heavy IDE whose backend must be a custom Docker-aware control plane. Sources: [TanStack Start getting started](https://tanstack.com/start/latest/docs/framework/react/getting-started), [execution model](https://tanstack.com/start/latest/docs/framework/react/guide/execution-model), [SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode), [hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting).
- Hono supports Bun and remains the preferred fallback if direct `Bun.serve` route handling becomes too low-level. Source: [Hono Bun guide](https://hono.dev/docs/getting-started/bun).
