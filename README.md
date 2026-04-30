# FRC-Programming-Training-Sim

An experimental browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. See [`Project-MVP.md`](./Project-MVP.md) for full scope and the task breakdown.

Status: Task 2 (AdvantageScope Lite hosted standalone) implemented. The browser-side editor and backend wiring (Tasks 3–4) are not built yet.

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

## Running the loop (Task 2 manual verification)

Two terminals:

```bash
# Terminal 1 — sim container (NT4 on :5810)
docker run --rm -p 5810:5810 --memory=2g frc-sim:mvp

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
containers/sim/        Docker sim image + WPILib hello-world (Task 1)
vendor/AdvantageScope/ Pinned submodule of upstream AdvantageScope, used to build AS Lite
scripts/               TypeScript build/run scripts (run via tsx)
dist/advantagescope/   Built AS Lite static bundle (gitignored; output of npm run build:ascope)
docs/decisions/        Numbered design notes for non-obvious choices
Project-MVP.md         Full MVP spec and task breakdown
CLAUDE.md              Repo notes for AI agents working in this repo
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run build:ascope` | Build AdvantageScope Lite from the pinned submodule into `dist/advantagescope/` |
| `npm run serve:ascope` | Serve `dist/advantagescope/` over plain HTTP on `:8080` (override with `PORT=...`) |
| `npm run typecheck` | `tsc --noEmit` over `scripts/` |
| `docker build -t frc-sim:mvp containers/sim` | Build the sim container (Task 1) |
| `docker run --rm -p 5810:5810 --memory=2g frc-sim:mvp` | Run the sim with NT4 on `:5810` |

## License

TBD. Vendored AdvantageScope source is BSD-3-Clause (Littleton Robotics).
