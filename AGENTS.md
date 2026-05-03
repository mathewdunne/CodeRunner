# FRC Web Simulator — Repo Notes for Codex

## What this is

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. Source of truth for scope and architecture: [`Project-MVP.md`](./Project-MVP.md). Read it before making any non-trivial change.

## Stack rule (non-negotiable)

All non-container code is **TypeScript on Node.js**. No Python, no Go, no plain JS. Inside the sim container, Java/Gradle/WPILib are the stack. See `Project-MVP.md` §Stack requirements.

## Repo layout

```
apps/<name>/            Workspace packages for non-container TS code. Currently `web` (browser shell), `server` (MVP backend), and `lsp` (JDT LS WebSocket bridge).
containers/<name>/      Per-container code. Currently `sim` and `lsp`. Future: router.
vendor/AdvantageScope/  Pinned submodule of upstream AdvantageScope (used to build AS Lite).
scripts/                Root TypeScript scripts run via tsx (build:ascope, serve:ascope).
dist/                   Build output (gitignored). dist/advantagescope/ is the AS Lite bundle.
docs/decisions/         Numbered design notes for non-obvious choices (001-, 002-, ...).
```

The root is an npm workspaces root (`"workspaces": ["apps/*"]`). Add new TS code as a new `apps/<name>/` package; root scripts (`build:ascope`, `serve:ascope`, `typecheck`) stay at the repo root and operate on root-level files. Don't add `packages/` speculatively — wait until shared code actually needs to be extracted.

## Implementation status

- [x] Task 1 — Sim container with hello-world WPILib project
- [x] Task 2 — AdvantageScope Lite hosted standalone
- [x] Task 3 — Minimal web shell (Monaco + AS Lite + Run + console)
- [x] Task 4 — Backend wiring for save and run

- [x] Java LSP MVP add-on - Monaco Java hover/completion/diagnostics via Eclipse JDT LS

## Working principles for this repo

- The author plans to rewrite most of this code post-MVP. Optimize for clarity and getting the loop functional, not production quality. Boring obvious option wins. Keep dep footprint reasonable.
- No tests beyond what `./gradlew build` runs by default. We're proving a loop, not shipping a library.
- Don't add features beyond the current task's deliverables. Each task has a definition-of-done that's verifiable without the next task — respect that boundary.

## Key references

- `Project-MVP.md` — full MVP spec, task breakdown, definitions of done.
- `docs/decisions/` — why we made non-obvious choices. Add an entry when you make one; reference the decision number from code comments only when the *why* is genuinely non-obvious.
- WPILib 2026 install on this machine: `C:\Users\Public\wpilib\2026`.
- Templates: `C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\` (java, shared/).
- Emscripten 4.0.12 install on this machine: `D:\Documents\GitHub\emsdk` (used by `scripts/build-ascope-lite.ts`; override with `EMSDK` env var). Required only for rebuilding AS Lite, not for running the loop. See `docs/decisions/002-advantagescope-lite-hosting.md`.
- Pinned AdvantageScope submodule: `vendor/AdvantageScope` at tag `v26.0.2`. Bump and rebuild via `npm run build:ascope`.

## Commands

- Build sim image: `docker build -t frc-sim:mvp containers/sim`
- Build Java LSP image: `docker build -f containers/lsp/Dockerfile -t frc-lsp:mvp .`
- Run sim: `docker run --rm -p 5810:5810 --memory=2g frc-sim:mvp`
- Run named MVP sim container: `docker run -d --name frc-sim-mvp -p 5810:5810 --memory=2g frc-sim:mvp`
- Run named MVP LSP container: `docker run -d --name frc-lsp-mvp -p 30003:30003 --memory=2g frc-lsp:mvp`
- Build AS Lite bundle: `npm run build:ascope` (writes `dist/advantagescope/`)
- Serve AS Lite: `npm run serve:ascope` (HTTP on `:8080`; override with `PORT=...`)
- Run Java LSP bridge on host: `npm run dev:lsp` (WS on `:30003/jdtls`; normally run in `frc-lsp-mvp`)
- Run backend: `npm run dev:server` (Fastify on `:4000`; override with `PORT=...`; uses `SIM_CONTAINER`, default `frc-sim-mvp`)
- Run web shell dev server: `npm run dev:web` (Vite on `:3000`; iframes AS Lite from `:8080`)
- Run full MVP dev stack: `npm run dev:mvp` (keeps/starts `frc-sim-mvp` and `frc-lsp-mvp`, then starts AS Lite, backend, and web)
- Typecheck root scripts: `npm run typecheck`. Web shell: `npm run typecheck --workspace apps/web`. Backend: `npm run typecheck --workspace apps/server`. LSP bridge: `npm run typecheck --workspace apps/lsp`.
- First-time setup: `git submodule update --init --recursive && npm install && npm run build:ascope`
- End-to-end verify Task 2: run sim and `serve:ascope`, open Chrome at `http://localhost:8080`, expect AS Lite connected with `/SmartDashboard/counter` incrementing on a Line Graph and `/SmartDashboard/robotPose` moving on a 2D Field tab.
- End-to-end verify Task 3: run sim, `serve:ascope`, and `dev:web` in three terminals; open Chrome at `http://localhost:3000`, expect Monaco showing `Robot.java` (editable), AS Lite iframe live with counter+pose, and clicking Run appends `clicked` to the console panel.
- End-to-end verify Task 4: rebuild `frc-sim:mvp`, run `npm run dev:mvp`, open `http://localhost:3000`, edit `Robot.java`, wait for auto-save, click Run, and expect build/sim logs plus AS Lite reconnecting to the updated NT4 data. Syntax errors should show raw Gradle compile output and recover after fixing the file and running again.
- End-to-end verify Java LSP: rebuild `frc-lsp:mvp`, run `npm run dev:mvp`, open `http://localhost:3000`, expect `java language server connected`, hover WPILib symbols such as `Pose2d`, request completions after `SmartDashboard.`, and introduce/fix a Java error to confirm Monaco diagnostics.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
