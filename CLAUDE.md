# FRC Web Simulator — Repo Notes for Claude

## What this is

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. Source of truth for scope and architecture: [`Project-MVP.md`](./Project-MVP.md). Read it before making any non-trivial change.

## Stack rule (non-negotiable)

All non-container code is **TypeScript on Node.js**. No Python, no Go, no plain JS. Inside the sim container, Java/Gradle/WPILib are the stack. See `Project-MVP.md` §Stack requirements.

## Repo layout

```
containers/<name>/      Per-container code. Currently only `sim`. Future: router, lsp.
vendor/AdvantageScope/  Pinned submodule of upstream AdvantageScope (used to build AS Lite).
scripts/                Root TypeScript scripts run via tsx (build:ascope, serve:ascope).
dist/                   Build output (gitignored). dist/advantagescope/ is the AS Lite bundle.
docs/decisions/         Numbered design notes for non-obvious choices (001-, 002-, ...).
```

When other top-level dirs appear (`apps/`, `packages/`, etc.) they will be npm/pnpm workspaces for the TS code. Don't add them speculatively — wait until a task needs them. Right now the root is a single npm package; promote to workspaces when Task 3 lands.

## Implementation status

- [x] Task 1 — Sim container with hello-world WPILib project
- [x] Task 2 — AdvantageScope Lite hosted standalone
- [ ] Task 3 — Minimal web shell (Monaco + AS Lite + Run + console)
- [ ] Task 4 — Backend wiring for save and run

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
- Run sim: `docker run --rm -p 5810:5810 --memory=2g frc-sim:mvp`
- Build AS Lite bundle: `npm run build:ascope` (writes `dist/advantagescope/`)
- Serve AS Lite: `npm run serve:ascope` (HTTP on `:8080`; override with `PORT=...`)
- Typecheck root scripts: `npm run typecheck`
- First-time setup: `git submodule update --init --recursive && npm install && npm run build:ascope`
- End-to-end verify Task 2: run sim and `serve:ascope`, open Chrome at `http://localhost:8080`, expect AS Lite connected with `/SmartDashboard/counter` incrementing on a Line Graph and `/SmartDashboard/robotPose` moving on a 2D Field tab.
