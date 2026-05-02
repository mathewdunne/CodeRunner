# FRC-Programming-Training-Sim

An experimental browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. See [`Project-MVP.md`](./Project-MVP.md) for full scope and the task breakdown.

Status: MVP tasks 1-4 are implemented (sim container, AdvantageScope Lite hosting, browser shell, backend save/run wiring), plus two post-MVP milestones: a Dark Modern editor theme (M1) and Eclipse JDT Language Server in a sidecar container providing autocomplete, hover, and inline diagnostics (M2). Both are wired through the standard `monaco-languageclient` + `@codingame/monaco-vscode-api` stack — see [`docs/decisions/009-stock-monaco-vscode.md`](./docs/decisions/009-stock-monaco-vscode.md).

## Prerequisites

- **Node.js ≥ 20** (`npm` ships with it)
- **Docker** (for the sim container from Task 1)
- **Emscripten 4.0.12** via [emsdk](https://github.com/emscripten-core/emsdk) — needed only when (re)building the AdvantageScope Lite bundle
- Git with submodule support

### Install Emscripten 4.0.12

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install 4.0.12
./emsdk activate 4.0.12
```

The build script defaults to `D:/Documents/GitHub/emsdk` for the project author's machine. Set the `EMSDK` env var if installed elsewhere:

```bash
export EMSDK=/path/to/emsdk    # bash
$env:EMSDK = "C:/path/to/emsdk" # PowerShell
```

The script prepends `$EMSDK` and `$EMSDK/upstream/emscripten` to PATH internally, so you don't need to source `emsdk_env` in the same shell — but you do need the toolchain physically installed and activated once.

## First-time setup

```bash
git clone <this-repo>
cd FRC-Programming-Training-Sim
git submodule update --init --recursive   # fetches vendor/AdvantageScope at v26.0.2
npm install                                # root dev deps (tsx, fastify)
npm run build:ascope                       # builds AS Lite → dist/advantagescope/
```

The AS Lite build downloads ~50 MB of bundled field/robot models on first run and takes several minutes (rollup + wasm). Subsequent runs are fast because `npm install` and the Lite bundles are cached.

To rebuild the sim image (Task 1) if you haven't yet:

```bash
docker build -t frc-sim:mvp containers/sim
```

## Running the MVP loop

Build both container images, then start the full local stack:

```bash
docker build -t frc-sim:mvp containers/sim
docker build -f containers/lsp/Dockerfile -t frc-lsp:mvp .
npm run dev:mvp
```

The LSP image's build context is the repo root (not `containers/lsp/`) because the Dockerfile copies `containers/sim/project/` to prime its own Gradle dependency cache.

`npm run dev:mvp` keeps or starts two named containers, `frc-sim-mvp` and `frc-lsp-mvp`, ensures the named volume `frc-project` exists, then launches:

- AS Lite static server on `http://localhost:8080`
- Backend on `http://localhost:4000`
- Web IDE on `http://localhost:3000`

Open [http://localhost:3000](http://localhost:3000). Monaco loads `Robot.java` through `GET /file`, edits auto-save through `POST /file`, and Run opens `WS /run` to stream Gradle and sim logs. The status pill briefly shows `lsp-loading` while jdtls boots inside `frc-lsp-mvp` (typically under 30s), then settles to `idle`. After that you should see live completions, hover tooltips, and red squigglies for type errors. AS Lite remains iframed from `:8080` and reconnects to NT4 on `:5810`.

### How the project tree is shared

The two containers share `/workspace/project` through the Docker named volume `frc-project`. On first startup the volume is empty, so Docker auto-populates it from whichever image mounts it first. Saves from the editor (`POST /file` → `docker exec frc-sim-mvp ...`) land in the volume and are immediately visible to jdtls inside `frc-lsp-mvp`. See [`docs/decisions/006-project-tree-volume.md`](./docs/decisions/006-project-tree-volume.md).

To verify a save from another terminal:

```bash
docker exec frc-sim-mvp cat /workspace/project/src/main/java/frc/robot/Robot.java
```

### Cleanup

Stopping `npm run dev:mvp` stops the host dev processes but leaves both containers running so the project state persists. To wipe state:

```bash
docker rm -f frc-sim-mvp frc-lsp-mvp
docker volume rm frc-project   # removes user edits — both images bake a fresh project, the volume re-initializes from the sim image on next start
```

### Memory

The sim container is capped at 2 GB; the LSP container at 4 GB. Co-running both costs ~5 GB resident on the host during jdtls cold start (Buildship's Gradle import is the worst offender), settling to ~3 GB once warm. Lowering the LSP cap below 4 GB triggers the kernel OOM killer mid-import — the symptom is a `language server failed` status that retries on reload but never reaches `idle`.

### LSP troubleshooting

- The first `/lsp` connection after a fresh container start can take ~30s while jdtls imports the Gradle project. Subsequent reconnects within the same container lifetime are nearly instant.
- The status pill flips to `idle` when `monaco-languageclient`'s `client.start()` resolves — that's when the LSP `initialize` handshake completes, which can be a few seconds before jdtls's Buildship Gradle import finishes. Completions for WPILib types may briefly return empty during that window even though the pill says `idle`. Wait a few more seconds on cold start.
- jdtls writes diagnostic logs to `/workspace/jdtls-data/.metadata/.log` inside `frc-lsp-mvp`. If completions/diagnostics never appear, check that file via `docker exec frc-lsp-mvp cat /workspace/jdtls-data/.metadata/.log`.
- If completions return nothing for WPILib types, the Gradle classpath import probably failed. Rebuilding `frc-lsp:mvp` re-primes the gradle cache.

## Running AS Lite standalone (Task 2 manual verification)

Two terminals:

```bash
# Terminal 1 — sim container (NT4 on :5810)
docker run --rm -p 5810:5810 -v frc-project:/workspace/project --memory=2g frc-sim:mvp

# Terminal 2 — AS Lite static server (:8080)
npm run serve:ascope
```

Then open [http://localhost:8080](http://localhost:8080) in Chrome.

What you should see:

1. AS Lite loads with **no console errors** (DevTools → Console).
2. The live-data status indicator shows **connected**.
3. Add a **Line Graph** tab → drag `/SmartDashboard/counter` onto it. Counter increments visibly.
4. Add a **2D Field** tab → drag `/SmartDashboard/robotPose` onto it. Pose moves in a circle.
5. Hard-reload the page (Ctrl-Shift-R). Reconnects automatically without manual config.

If the WebSocket fails:

- Browser must be on `http://`, not `https://` (mixed content blocks `ws://`).
- Confirm the sim container has `-p 5810:5810` and `docker logs <id>` shows `NT: Listening on … NT4 port 5810`.
- Confirm `dist/advantagescope/bundles/hub.js` contains the string `AdvantageScopeLite` (proves it's a Lite build, not a regular AdvantageScope bundle).

If the page loads but is unstyled or 404s on `/www/*` or `/assets`:

- Confirm `dist/advantagescope/www/` is a directory (not a 9-byte file). The build script resolves git symlinks that Windows otherwise checks out as text files. Re-run `npm run build:ascope`.
- Confirm `npm run serve:ascope` logged `Asset manifest: <N> entries` at startup and `<N>` is non-zero. The manifest powers AS Lite's field/robot picker.

## How AS Lite finds the NT4 server (the part worth documenting)

When AdvantageScope is built with `ASCOPE_DISTRIBUTION=LITE`, the hub source (`vendor/AdvantageScope/src/hub/hub.ts`) hardcodes the live data source to `window.location.hostname` and `NT4_PORTS_DEFAULT[0] = 5810`. It also auto-starts the connection without a user click and ignores the `robotAddress` preference.

So serving the Lite bundle from `http://localhost:8080` and running the sim's NT4 server on `localhost:5810` "just works" — no source patches, query params, or postMessage shims required. The MVP spec listed AS Lite NT4 endpoint configuration as the riskiest open question; the answer turned out to be "the upstream distribution gating already handles it."

This same property keeps Task 3 simple: AS Lite loaded in an iframe sees its own iframe origin's hostname, so a future frontend dev server on `:3000` + AS Lite on `:8080` + sim NT4 on `:5810` coexist without any cross-origin config.

See [`docs/decisions/002-advantagescope-lite-hosting.md`](./docs/decisions/002-advantagescope-lite-hosting.md) for the longer write-up, including how to upgrade the AS submodule.

## Repo layout

```
apps/web/              Vite browser shell with Monaco, AS Lite iframe, console, and Run
apps/server/           Fastify backend for file save, build/restart, log streaming, and the /lsp bridge
containers/sim/        Docker sim image + WPILib hello-world (Task 1)
containers/lsp/        Docker image hosting Eclipse JDT Language Server (Post-MVP M2)
vendor/AdvantageScope/ Pinned submodule of upstream AdvantageScope, used to build AS Lite
scripts/               TypeScript build/run scripts (run via tsx)
dist/advantagescope/   Built AS Lite static bundle (gitignored; output of npm run build:ascope)
docs/decisions/        Numbered design notes for non-obvious choices
Project-MVP.md         Full MVP spec and task breakdown
AGENTS.md             Repo notes for AI agents working in this repo
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run build:ascope` | Build AdvantageScope Lite from the pinned submodule into `dist/advantagescope/` |
| `npm run serve:ascope` | Serve `dist/advantagescope/` over plain HTTP on `:8080` (override with `PORT=...`) |
| `npm run dev:server` | Run the MVP backend on `:4000` (override with `PORT=...`; uses `SIM_CONTAINER`, default `frc-sim-mvp`) |
| `npm run dev:web` | Run the Vite web IDE on `:3000` |
| `npm run dev:mvp` | Ensure `frc-sim-mvp` is running, then start AS Lite, backend, and web dev servers |
| `npm run typecheck` | `tsc --noEmit` over `scripts/` |
| `npm run typecheck --workspace apps/server` | Typecheck the backend |
| `npm run typecheck --workspace apps/web` | Typecheck the browser shell |
| `docker build -t frc-sim:mvp containers/sim` | Build the sim container (Task 1) |
| `docker build -f containers/lsp/Dockerfile -t frc-lsp:mvp .` | Build the LSP container (M2). Build context must be the repo root. |
| `docker run --rm -p 5810:5810 -v frc-project:/workspace/project --memory=2g frc-sim:mvp` | Run the sim with NT4 on `:5810` and the shared project volume |
| `docker run -d --name frc-sim-mvp -p 5810:5810 -v frc-project:/workspace/project --memory=2g frc-sim:mvp` | Run the named long-lived MVP sim container used by the backend |
| `docker run -d --name frc-lsp-mvp -v frc-project:/workspace/project --memory=4g frc-lsp:mvp` | Run the named long-lived LSP container used by the backend |

## License

TBD. Vendored AdvantageScope source is BSD-3-Clause (Littleton Robotics).
