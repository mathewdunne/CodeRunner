# FRC Web Simulator — Repo Notes for Codex

## What This Is

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite.

Source of truth for V1 scope and architecture: [`V1-Design.md`](./V1-Design.md). Read it fully before implementing any V1 task.

## Stack Rule

All V1 non-container code is **TypeScript on Bun**. Use Bun for package management, TypeScript script execution, and the V1 control-plane runtime. Keep `tsc --noEmit`/project references for typechecking.

Inside sim and LSP containers, Java/Gradle/WPILib and Eclipse JDT LS are still the relevant stacks.

The archived MVP under `mvp/` remains TypeScript on Node/npm/tsx. Do not migrate or evolve MVP code unless explicitly asked.

## Repo Layout

```text
apps/control/                  Bun control plane: HTTP, WS, sessions, orchestration
apps/web/                      React + Vite browser IDE shell
packages/contracts/            Shared API schemas, message types, and path rules
containers/sim/                V1 sim image, mounted project at runtime
containers/lsp/                V1 JDT LS image and bridge
templates/wpilib-java-command/ Source of truth for new student WPILib projects
scripts/                       V1 TypeScript scripts run by Bun
patches/advantagescope/        Source-level AS Lite patches
docs/decisions/                V1 and later decision logs
vendor/AdvantageScope/         Pinned upstream submodule
mvp/                           Archived MVP implementation and docs
data/                          Runtime data, gitignored
```

## Current Status

- [x] V1-0: MVP archived and V1 scaffold created
- [x] V1-1: contracts, storage, and session skeleton
- [x] V1-2: control-plane routing and static shell
- [x] V1-3: project store and multi-file editor
- [x] V1-4: V1 sim image and container orchestrator
- [x] V1-5: run queue and log streaming
- [x] V1-6: NT4 route and AS Lite source patch
- [x] V1-7: V1 LSP container and project-wide Java LSP
- [x] V1-8: idle teardown, recovery, and operator controls
- [x] V1-9: resource tuning and classroom runbook
- [x] V1-10: V1 acceptance pass

V1-10 is the acceptance pass: docs finalized, 3-user automated smoke passes, manual test procedures documented in `docs/manual-tests.md`. V1-9 adds `.env.example` documenting all configurable environment variables, config summary logging at startup, a 3-user classroom smoke script (`verify:v1:three-user`), host resource measurement tool (`measure`), project backup/restore scripts (`backup`, `restore`), and a comprehensive operator runbook at `docs/runbook.md` covering setup, start, stop, backup, restore, cache cleanup, common failures, and host sizing. Earlier V1 phases provide the shared contracts, SQLite migrations, signed-cookie login/session flow, first-login workspace creation from `templates/wpilib-java-command/`, workspace file APIs, the React/Vite multi-file shell, the mounted-project sim image, Docker lease orchestration, loopback port allocation, the global run queue, persistent run logs, `/scope/` AS Lite serving, authenticated NT4 routes, AS Lite endpoint-injection patches, per-workspace Eclipse JDT LS containers with a Bun-native WebSocket-to-stdio bridge, a project-wide multi-file Java LSP client in the web shell, idle teardown, container lifecycle operator controls, and admin API routes. The MVP archive contains the completed single-user proof loop and Java LSP add-on.

## Working Principles

- Keep V1 task boundaries intact. Do not add future-task features early unless the current contract would otherwise be wrong.
- Prefer boring, explicit TypeScript over clever abstractions.
- Use shared contracts before changing API shapes.
- Add or update a decision log for non-obvious architecture or tooling choices.
- Preserve student data under `data/users/<workspaceId>/project`.
- Do not use query-param user identity in V1 production routes.
- Do not expose per-user sim or LSP ports directly to the browser.
- Keep AS Lite patches source-level and repeatable.

## Key References

- `V1-Design.md` — V1 design, phases, and definitions of done.
- `mvp/Project-MVP.md` — original MVP spec.
- `mvp/docs/decisions/` — proven MVP decisions worth reading before copying behavior.
- WPILib 2026 install on this machine: `C:\Users\Public\wpilib\2026`.
- WPILib Gradle templates: `C:\Users\Public\wpilib\2026\utility\resources\app\resources\gradle\`.
- Emscripten 4.0.12 install on this machine: `D:\Documents\GitHub\emsdk`.
- Pinned AdvantageScope submodule: `vendor/AdvantageScope` at tag `v26.0.2`.

## Commands

- Install V1 dependencies: `bun install`
- Typecheck V1: `bun run typecheck`
- Run Bun tests: `bun run test`
- Build V1 sim image: `bun run docker:build:sim`
- Build V1 LSP image: `bun run docker:build:lsp`
- Apply/check V1 migrations: `bun run migrate`, `bun run migrate:status`
- Start V1 control plane: `bun run dev:control`
- Start web shell directly: `bun run dev:web`
- Two-user verify: `bun run verify:v1:two-user`
- Three-user smoke: `bun run verify:v1:three-user`
- Measure resources: `bun run measure`
- Backup projects: `bun run backup`
- Restore projects: `bun run restore -- <backup-dir>`
- Cleanup containers: `bun run docker:cleanup`

MVP commands live in `mvp/README.md`. See `docs/runbook.md` for full operator documentation.

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code files in this session, run `graphify update .` to keep the graph current.
