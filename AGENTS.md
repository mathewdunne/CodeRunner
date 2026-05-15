# CodeRunner — Repo Notes for Codex

## What This Is

A browser-based IDE for learning FRC robot programming. Students write Java, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. V2 uses per-student openvscode-server containers with bundled redhat.java and wpilibsuite.vscode-wpilib extensions for full VS Code editor features.

Source of truth for V2 scope and architecture: [`V2-Design.md`](./V2-Design.md). V1 and MVP materials are historical references archived in-repo.

## Stack Rule

All non-container code is **TypeScript on Bun**. Use Bun for package management, TypeScript script execution, and the control-plane runtime. Keep `tsc --noEmit`/project references for typechecking.

Inside the V2 code container, Java/Gradle/WPILib, openvscode-server, `redhat.java`, and `wpilibsuite.vscode-wpilib` are the relevant stacks.

## Repo Layout

```text
apps/control/                  Bun control plane: HTTP, WS, sessions, orchestration
apps/control/src/app.ts          slim factory + top-level fetch dispatcher
apps/control/src/app/            response/asset/proxy/status helpers + admin, workspace, websocket route groups
apps/control/src/containers.ts   barrel re-exporting the public container surface
apps/control/src/containers/     Docker client, metadata, ports, lifecycle, and the LocalDockerRuntimeProvider class
apps/web/                      React + Vite browser IDE shell
packages/contracts/            Shared API schemas, message types, and path rules
containers/code/               V2 merged openvscode-server + sim container
templates/wpilib-java-command/ Source of truth for new student WPILib projects
scripts/                       TypeScript utility scripts run by Bun
patches/advantagescope/        Source-level AS Lite patches
docs/decisions/                Decision logs
docs/archive/mvp-docs/         Archived MVP documents and decision logs
vendor/AdvantageScope/         Pinned upstream submodule
data/                          Runtime data, gitignored
```

## Current Status

- [x] V1-0 through V1-10: V1 complete (archived)
- [x] V2-0: editor spike accepted and recorded in `docs/decisions/011-v2-editor-spike.md`
- [x] V2-1: merged code container image
- [x] V2-2: authenticated editor proxy
- [x] V2-3: orchestrator merge and run-path migration
- [x] V2-4: web shell swap to hosted openvscode editor
- [x] V2-5: file API and contracts cleanup
- [x] V2-6: lifecycle, labels, and reconciliation
- [x] V2-7: acceptance pass

V2 is complete. The system uses per-student merged containers (`frc-code:v2`) running openvscode-server with bundled Java and WPILib extensions. The control plane proxies editor, run, and telemetry traffic through authenticated routes.

## Working Principles

- Prefer boring, explicit TypeScript over clever abstractions.
- Use shared contracts before changing API shapes.
- Add or update a decision log for non-obvious architecture or tooling choices.
- Preserve student data under `data/users/<workspaceId>/project`.
- Do not use query-param user identity in production routes.
- Do not expose per-user editor or NT4 ports directly to the browser.
- Keep AS Lite patches source-level and repeatable.
- Do not re-verify upstream extension-owned behavior unless editor or extension versions changed. Decision 011 is the evidence record.

## Key References

- `V2-Design.md` — V2 design, phases, and definitions of done.
- `docs/decisions/011-v2-editor-spike.md` — accepted openvscode/redhat.java/WPILib spike evidence.
- `V1-Design.md` — archived V1 design, phases, and definitions of done.
- `docs/archive/mvp-docs/Project-MVP.md` — original MVP spec, archived for historical context.
- `docs/archive/mvp-docs/decisions/` — archived MVP decisions.
- Pinned AdvantageScope submodule: `vendor/AdvantageScope` at tag `v26.0.2`.

## Commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Run Bun tests: `bun run test`
- Build V2 code image: `bun run docker:build:code`
- Apply/check migrations: `bun run migrate`, `bun run migrate:status`
- Start control plane: `bun run dev:control`
- Start web shell directly: `bun run dev:web`
- Measure resources: `bun run measure`
- Backup projects: `bun run backup`
- Restore projects: `bun run restore -- <backup-dir>`
- Cleanup containers: `bun run docker:cleanup`

See `docs/runbook.md` for full operator documentation.

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code files in this session, run `graphify update .` to keep the graph current.
