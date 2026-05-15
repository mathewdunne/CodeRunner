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
apps/control/src/metrics.ts      Prometheus registry, metric handles, route-templating helpers
apps/control/src/metrics-collector.ts  15s Docker stats poller that writes per-container gauges
apps/web/                      React + Vite browser IDE shell
packages/contracts/            Shared API schemas, message types, and path rules
containers/code/               V2 merged openvscode-server + sim container
templates/wpilib-java-command/ Source of truth for new student WPILib projects
scripts/                       TypeScript utility scripts run by Bun
patches/advantagescope/        Source-level AS Lite patches
docs/decisions/                Decision logs
docs/archive/mvp-docs/         Archived MVP documents and decision logs
vendor/AdvantageScope/         Pinned upstream submodule
e2e/                           Playwright E2E tests (specs/ and fixtures/)
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
- Keep metrics instrumentation backend-agnostic. The control plane only speaks Prometheus exposition at `/metrics`; deploy-specific shipping (Alloy → Grafana Cloud, or whatever replaces it) lives outside `apps/control/`. Decision 023 is the record.

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
- Run frontend tests (Vitest): `bun run test:web`
- Run E2E tests (Playwright, mocked tier): `bun run e2e`
- Run E2E security tests: `bun run e2e:security`
- Build V2 code image: `bun run docker:build:code`
- Apply/check migrations: `bun run migrate`, `bun run migrate:status`
- Start control plane: `bun run dev:control`
- Start web shell directly: `bun run dev:web`
- Measure resources: `bun run measure`
- Backup projects: `bun run backup`
- Restore projects: `bun run restore -- <backup-dir>`
- Cleanup containers: `bun run docker:cleanup`

See `docs/runbook.md` for full operator documentation.

## Testing

Three test tiers, all runnable without Docker:

- **`bun run test`** — Bun unit/integration tests for the control plane (~263 tests). Covers auth, runs, proxy, containers, security, reconciliation, property-based tests, and metrics route-templating cardinality.
- **`bun run test:web`** — Vitest frontend tests (~65 tests). Covers React hooks (`useSession`, `useSimulationState`, `useContainerStatus`, `useAutoChoosers`, `useGamepad`, `useRunChannel`), DriverStation components, Zustand store, keyboard/gamepad mappings.
- **`bun run e2e`** — Playwright E2E mocked tier (~55 tests). Full login→editor→run→telemetry→DS flows against in-process `ControlApp` with fake openvscode-server, HALSim, and NT4 backends. No Docker required.
- **`bun run e2e:security`** — Playwright security specs (CSRF, XSS output encoding, response headers).

E2E tests use a custom Playwright fixture (`e2e/fixtures/app.ts`) that creates an isolated `ControlApp` per test with its own random port, SQLite DB, and fake upstream servers. Auth is seeded via `loginAs()` which writes user/session rows and HMAC-signs cookies.

Key E2E fixtures:
- `e2e/fixtures/fake-vscode.ts` — Fake openvscode-server (HTTP + WS upgrade)
- `e2e/fixtures/fake-halsim.ts` — Fake HALSim bridge (WS, supports stop/restart)
- `e2e/fixtures/fake-nt4.ts` — Fake NT4 server for topic announcement
- `e2e/fixtures/gamepad-shim.ts` — Playwright addInitScript gamepad override
- `e2e/fixtures/runtime.ts` — Runtime seeding helpers

The Docker smoke tier (`e2e:docker`) was intentionally not implemented — see `docs/decisions/022-skip-docker-smoke-and-import-tests.md`. Import/backup-restore tests are deferred pending a flow rework.

See `TESTING-PLAN.md` for the full test architecture and catalog.

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code files in this session, run `graphify update .` to keep the graph current.
