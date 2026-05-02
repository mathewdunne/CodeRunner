# FRC Web Simulator — Repo Notes for Claude

## What this is

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. Source of truth for scope and architecture: [`Project-MVP.md`](./Project-MVP.md). Read it before making any non-trivial change.

## Stack rule (non-negotiable)

All non-container code is **TypeScript on Node.js**. No Python, no Go, no plain JS. Inside the sim container, Java/Gradle/WPILib are the stack. See `Project-MVP.md` §Stack requirements.

## Repo layout

```
apps/<name>/            Workspace packages for non-container TS code. Currently `web` (browser shell) and `server` (MVP backend).
containers/<name>/      Per-container code. Currently `sim` (WPILib runner) and `lsp` (jdtls). Future: router.
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
- [x] Post-MVP M1 — Dark Modern syntax theme via the stock `@codingame/monaco-vscode-theme-defaults-default-extension` + `@codingame/monaco-vscode-java-default-extension` (replaces an earlier hand-rolled TextMate adapter; see `docs/decisions/005-editor-theme-textmate.md` for history and `009-stock-monaco-vscode.md` for the current implementation).
- [x] Post-MVP M2 — jdtls in a sidecar `frc-lsp:mvp` container, `/lsp` WebSocket bridge in the backend, and `monaco-languageclient` in `apps/web` (replaces an earlier hand-rolled Monaco LSP adapter). Project tree shared between sim and LSP containers via Docker named volume `frc-project`. See `docs/decisions/006-project-tree-volume.md`, `007-jdtls-container.md`, `008-lsp-wiring.md`, and `009-stock-monaco-vscode.md`.

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
- Build LSP image: `docker build -f containers/lsp/Dockerfile -t frc-lsp:mvp .` (build context is the repo root because the Dockerfile copies `containers/sim/project/` to prime its own gradle cache)
- Run sim: `docker run --rm -p 5810:5810 --memory=2g frc-sim:mvp` (use `-v frc-project:/workspace/project` if you want edits to persist across runs)
- Run named MVP sim container: `docker run -d --name frc-sim-mvp -p 5810:5810 -v frc-project:/workspace/project --memory=2g frc-sim:mvp`
- Run named LSP container: `docker run -d --name frc-lsp-mvp -v frc-project:/workspace/project --memory=4g frc-lsp:mvp` (jdtls + Buildship gradle import needs ~3 GB resident; 2 GB triggers the OOM killer)
- Build AS Lite bundle: `npm run build:ascope` (writes `dist/advantagescope/`)
- Serve AS Lite: `npm run serve:ascope` (HTTP on `:8080`; override with `PORT=...`)
- Run backend: `npm run dev:server` (Fastify on `:4000`; override with `PORT=...`; uses `SIM_CONTAINER` / `LSP_CONTAINER`, defaults `frc-sim-mvp` / `frc-lsp-mvp`)
- Run web shell dev server: `npm run dev:web` (Vite on `:3000`; iframes AS Lite from `:8080`)
- Run full MVP dev stack: `npm run dev:mvp` (keeps/starts `frc-sim-mvp` and `frc-lsp-mvp`, ensures volume `frc-project`, then starts AS Lite, backend, and web)
- Typecheck root scripts: `npm run typecheck`. Web shell: `npm run typecheck --workspace apps/web`. Backend: `npm run typecheck --workspace apps/server`.
- First-time setup: `git submodule update --init --recursive && npm install && npm run build:ascope`
- End-to-end verify Task 2: run sim and `serve:ascope`, open Chrome at `http://localhost:8080`, expect AS Lite connected with `/SmartDashboard/counter` incrementing on a Line Graph and `/SmartDashboard/robotPose` moving on a 2D Field tab.
- End-to-end verify Task 3: run sim, `serve:ascope`, and `dev:web` in three terminals; open Chrome at `http://localhost:3000`, expect Monaco showing `Robot.java` (editable), AS Lite iframe live with counter+pose, and clicking Run appends `clicked` to the console panel.
- End-to-end verify Task 4: rebuild `frc-sim:mvp`, run `npm run dev:mvp`, open `http://localhost:3000`, edit `Robot.java`, wait for auto-save, click Run, and expect build/sim logs plus AS Lite reconnecting to the updated NT4 data. Syntax errors should show raw Gradle compile output and recover after fixing the file and running again.
- Verify Dark Modern theme: open `http://localhost:3000` and confirm `Robot.java` highlighting matches VS Code with the Dark Modern theme (keywords blue, types teal, strings orange, comments green, default-fg `#CCCCCC`). Source: `@codingame/monaco-vscode-java-default-extension` (grammar) + `@codingame/monaco-vscode-theme-defaults-default-extension` (theme), wired through `MonacoVscodeApiWrapper` in `apps/web/src/monaco-setup.ts` with `'workbench.colorTheme': 'Default Dark Modern'`. Bump those packages to refresh the grammar/theme.
- End-to-end verify M2 (jdtls): build both `frc-sim:mvp` and `frc-lsp:mvp`, run `npm run dev:mvp`, open `http://localhost:3000`. Status pill shows `lsp-loading` then `idle` (under ~30s). Type `RobotB` and expect a completion list; introduce `int x = "oops";` and expect a red squiggle within ~1s; remove the error and the squiggle clears. Run still works end-to-end. After closing the page, `docker exec frc-lsp-mvp pgrep -fa java` is empty (no leaked jdtls processes).
