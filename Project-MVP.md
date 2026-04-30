# FRC Web Simulator: Project Summary and MVP Spec

## Project summary

A browser-based IDE for learning FRC robot programming. Students write Java code against the WPILib command-based framework, click run, and watch their robot simulate in real time with full telemetry visualization via AdvantageScope Lite. No local install required.

The full system will eventually support ~10 concurrent students on self-hosted hardware, with isolated per-student build/sim containers, a session router for WebSocket traffic, and a Java language server for in-browser autocomplete. This document scopes only the MVP, which proves the core technical loop works for a single user before any multi-tenancy is built.

## Stack requirements

- **All non-container code must be TypeScript on Node.js.** This applies to the backend service, any build scripts, and the frontend. No Python, no Go, no plain JS.
- Use a single repo with a workspace setup (npm workspaces, pnpm workspaces, or similar) if separating frontend and backend packages.
- Pick whatever frontend framework is fastest for a single page (or vanilla TS with Vite). The frontend will likely be rewritten after MVP, so do not over-invest.
- Pick whatever backend HTTP/WS framework is fastest (Fastify, Hono, Express + ws, etc.). Same rewrite caveat applies.
- Inside the sim container, Java/Gradle/WPILib are the stack and TypeScript does not apply.

## MVP scope

One hardcoded user, one hardcoded project, no auth. The MVP must demonstrate this end-to-end loop:

1. User edits `Robot.java` in a Monaco editor in the browser
2. User clicks Run
3. Backend writes the file to a project directory, triggers a Gradle build, launches the sim
4. Sim runs headless and exposes NT4 over WebSocket
5. AdvantageScope Lite embedded in the page connects to the sim's NT4 server and displays live telemetry
6. Console panel streams build and sim stdout/stderr to the browser

Anything outside this loop (multi-user, auth, LSP, driver station, project templates, polish) is explicitly out of scope.

## Architecture (MVP)

```
+----------------------------------+
|        Browser (single page)     |
|                                  |
|  [Monaco]  [AdvantageScope Lite] |
|  [Run]     [Console]             |
+----------------------------------+
|               |
| HTTP/WS       | WS (NT4)
v               v
+----------------------------------+
|       Backend service (Node TS)  |
|  - Save file                     |
|  - Trigger build/run             |
|  - Stream logs                   |
+----------------------------------+
|
| exec / proxy
v
+----------------------------------+
|       Sim container              |
|  - JDK + Gradle + WPILib cache   |
|  - Hello-world command-based     |
|    project                       |
|  - Headless sim, NT4 server      |
+----------------------------------+
```
For the MVP, the backend can run on the host and exec into a single long-lived container. No dynamic container lifecycle yet.

## Tech stack assumptions

- Backend: Node.js (LTS) + TypeScript. WebSocket support required.
- Frontend: TypeScript, Monaco loaded via npm. Vite or similar for dev server and bundling.
- Container: Docker, Linux, JDK 17, Gradle, WPILib (current season).
- AdvantageScope Lite: built from source with `ASCOPE_DISTRIBUTION=lite`, served as static assets.
- Use git submodules to include the AdvantageScope repository for building AS-lite.

## Tasks

Each task has a definition of done that is verifiable without running the next task.

---

### Task 1: Sim container with hello-world project

**Goal:** Build a Docker image that can build and run a WPILib command-based Java project headless, exposing NT4.

**Deliverables:**
- `Dockerfile` based on a JDK 17 base image
- `~/.gradle/caches` pre-populated with WPILib dependencies for the target season (achieved via a Gradle build during image build)
- A baked-in hello-world command-based project at `/workspace/project` that publishes the following to NT4 from `robotPeriodic`:
  - A counter integer at `/SmartDashboard/counter` that increments each tick
  - A simulated `Pose2d` at `/SmartDashboard/robotPose` that moves in a circle
- An entrypoint script that runs `./gradlew simulateJava` headless with the NT4 server bound to `0.0.0.0` on a known port (default 5810)
- Sim launches without requiring SimGUI or any X server

**Definition of done:**
- `docker build` completes successfully on a clean machine in under 10 minutes
- `docker run -p 5810:5810 <image>` starts the sim and prints "NT: server: listening" or equivalent within 30 seconds
- Connecting desktop AdvantageScope to `localhost:5810` shows the counter incrementing and the pose moving
- Container runs cleanly with `--memory=2g` cap

**Out of scope:** dynamic project mounting, hot reload, driver station, multiple containers.

---

### Task 2: AdvantageScope Lite hosted standalone

**Goal:** Build AdvantageScope Lite from source, serve it from a local web server, and configure it to connect to the NT4 server from Task 1.

**Deliverables:**
- A TypeScript build script (run via `tsx` or `ts-node`) that clones AdvantageScope, runs the Lite distribution build (`ASCOPE_DISTRIBUTION=lite`), and outputs a static bundle to `dist/advantagescope/`
- A local Node-based static web server that serves the bundle at `http://localhost:8080`
- A configuration mechanism (query param, hardcoded URL patch, or postMessage) that points AS Lite at `ws://localhost:5810` for NT4 by default
- Documentation in a `README.md` of how the connection is configured (this is the riskiest part of MVP, document what worked)

**Definition of done:**
- AS Lite loads in Chrome at `http://localhost:8080` without console errors
- AS Lite shows "connected" status to the sim from Task 1
- The counter value from Task 1 is visible in a Line Graph tab in AS Lite
- The pose from Task 1 is visible in the 2D Field tab in AS Lite, moving in a circle
- Page reload reconnects automatically without manual config

**Out of scope:** styling, embedding inside another page, multi-server selection UI.

**Risk note:** AS Lite is designed for the Systemcore on-robot context. If configuring the NT4 endpoint cleanly is not possible without invasive source patching, document the blocker and surface it before continuing. Falling back to a custom minimal viz is acceptable but should be a deliberate decision.

---

### Task 3: Minimal web shell

**Goal:** Build a single-page TypeScript web app that hosts Monaco, embeds AS Lite, shows a Run button, and shows a console panel. No backend wiring yet.

**Deliverables:**
- `index.html` plus TypeScript entry with a two-column layout: Monaco on the left, AS Lite (iframe or embed) on the right
- A bottom panel with a console area (just a scrolling div) and a Run button
- Monaco loads `Robot.java` from a static file fetch and displays it with Java syntax highlighting
- The Run button is wired to a no-op handler that logs "clicked" to the console panel
- AS Lite loads and connects to the sim from Task 1 (still running standalone)
- Vite (or equivalent) dev server with TypeScript strict mode enabled

**Definition of done:**
- Page loads in Chrome with no console errors and no TypeScript compile errors
- Monaco displays `Robot.java` contents with syntax highlighting and is editable (changes are not persisted yet)
- AS Lite is visible and shows live data from the sim
- Run button click appends "clicked" to the console panel
- Layout is usable on a 1920x1080 display (no styling polish required beyond functional)

**Out of scope:** file tree, multiple files, tabs, theming, responsive layout.

---

### Task 4: Backend wiring for save and run

**Goal:** Stand up a Node.js + TypeScript backend service that accepts file saves from the editor, triggers a build/sim restart in the container, and streams logs back to the console panel.

**Deliverables:**
- Node + TypeScript backend service with three endpoints:
  - `GET /file` returns the current contents of `Robot.java` from the container's project dir
  - `POST /file` writes the request body to `Robot.java` in the container's project dir
  - `WS /run` triggers a build + sim restart and streams stdout/stderr line-by-line to the connected client; connection closes when sim exits or on error
- Container interaction via `docker exec` (shell out from Node) or the `dockerode` library, your call
- Frontend changes:
  - Monaco loads `Robot.java` via `GET /file` instead of a static fetch
  - A debounced auto-save calls `POST /file` on edit (debounce ~500ms)
  - Run button opens a WS connection to `/run`, displays incoming lines in the console panel, and shows a status indicator (idle / building / running / error)
- The sim container from Task 1 is started once and kept running; the backend execs into it to write files and run gradle
- TypeScript strict mode on backend, shared types between frontend and backend if practical (a shared package or simple `types.ts`)

**Definition of done:**
- Editing `Robot.java` in the browser and waiting 1 second results in the file being written inside the container (verifiable via `docker exec` and `cat`)
- Clicking Run streams build output to the console panel within 2 seconds of click
- A successful build is followed by sim startup, and the new sim's NT4 data appears in AS Lite within 15 seconds of clicking Run
- Introducing a syntax error in the editor and clicking Run results in compile errors visible in the console panel and a clear "build failed" status
- Fixing the syntax error and clicking Run again succeeds without restarting any services manually

**Out of scope:** stop button, restart-on-save, multi-file projects, error highlighting in Monaco, persistence across page reloads beyond what the container filesystem provides.

---

## Overall MVP definition of done

All of the following must be true on a single developer machine:

1. Running `docker compose up` (or equivalent single command) starts the sim container, the backend, and the static web server
2. Opening `http://localhost:3000` (or chosen port) loads the IDE page with Monaco showing `Robot.java` and AS Lite connected to the sim
3. A user can:
   - Edit `Robot.java` to change the published counter increment rate (e.g. from +1 to +5 per tick)
   - Click Run
   - See build output stream in the console panel
   - See the new behavior reflected in AS Lite within 15 seconds
4. A syntax error in the editor produces a visible build failure with compile errors in the console, and recovery from that error works without manual intervention
5. The full loop works repeatedly without restarts, memory leaks, or hung processes across at least 10 edit-run cycles
6. All TypeScript code compiles cleanly under strict mode with no `any` leakage in public interfaces

## Explicitly deferred to post-MVP

- Multi-user support and session routing
- Authentication and project ownership
- Project picker, file tree, multiple files, tabs
- Java language server (jdtls) for autocomplete and diagnostics
- Driver station controls (enable/disable, mode, gamepad input)
- Project templates beyond the hardcoded hello-world
- Stop button, restart button, status indicators beyond minimal
- Styling, theming, responsive design
- Error surfacing beyond raw console output
- Persistence of student work across container rebuilds
- Production deployment, TLS, observability

## Note to the implementing agent

The author intends to rewrite most of this code after verifying the MVP works end to end. Optimize for clarity and getting the loop functional, not for production quality, premature abstraction, or extensive testing. Keep the codebase small and the dependency footprint reasonable. When in doubt, choose the boring obvious option.
