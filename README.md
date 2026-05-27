# CodeRunner

A browser-based IDE for learning FRC robot programming. Students write Java in a full VS Code editor (openvscode-server), run a WPILib simulation, and view telemetry through AdvantageScope Lite.

Status: **V2 complete.** Each student gets a per-student container running openvscode-server with the redhat.java and wpilibsuite.vscode-wpilib extensions, providing auto-import, Ctrl-click into library classes, diagnostics, and full VS Code features. See [`V2-Design.md`](V2-Design.md) for architecture.

See [`docs/runbook.md`](docs/runbook.md) for operator setup, [`docs/manual-tests.md`](docs/manual-tests.md) for acceptance test procedures, and [`V2-Design.md`](V2-Design.md) for architecture. Historical V1 and MVP documents are preserved in [`V1-Design.md`](V1-Design.md) and [`docs/archive/mvp-docs/`](docs/archive/mvp-docs/).

## Try it locally (demo mode)

Want to poke at CodeRunner without configuring OAuth, an allowlist, or anything else? Run with `--demo`:

```powershell
git submodule update --init --recursive
bun install
bun run build
bun run start -- --demo
```

Then open `http://localhost:4000/` — you land directly in the IDE as a single seeded admin user with workspace slug `demo`. Docker must be running (the workspace image is pulled by `bun run build`).

> **Warning**: demo mode bypasses authentication entirely. Every visitor resolves to the same admin user and shares one workspace. Do not expose a demo instance to the public internet. The env var `CODERUNNER_DEMO_MODE=1` works as an alias for the flag.

## Prerequisites

- Bun 1.3.13 or newer
- Docker, for code container tasks
- Git with submodule support
- PowerShell 7 (`pwsh`) on Windows

## Setup

```powershell
git submodule update --init --recursive
bun install
bun run typecheck
```

## Layout

```text
apps/control/                  Bun control plane with login, sessions, storage, routing, and APIs
apps/control/src/app.ts          slim factory + top-level fetch dispatcher
apps/control/src/app/            response/asset/proxy/status helpers + admin, workspace, websocket route groups
apps/control/src/containers.ts   barrel re-exporting the public container surface
apps/control/src/containers/     Docker client, metadata, ports, lifecycle, and the LocalDockerRuntimeProvider class
apps/web/                      React + Vite browser shell served by the control plane
packages/contracts/            Shared schemas, message types, and path rules
containers/code/               V2 merged openvscode-server + sim container
templates/wpilib-java-command/ WPILib Java command-based starter template
scripts/                       Bun utility scripts
patches/advantagescope/        Source-level AS Lite patches
vendor/AdvantageScope/         Pinned upstream submodule
e2e/                           Playwright E2E tests and fixtures
docs/archive/mvp-docs/         Archived MVP documents and decision logs
```

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install workspace dependencies and write `bun.lock` |
| `bun run start` | Apply pending migrations and serve the control plane (use as the prod entry point) |
| `bun run build` | Prod build: web bundle + AdvantageScope Lite + pull workspace image from GHCR |
| `bun run clean` | Remove `apps/web/dist` and `dist/advantagescope` |
| `bun run typecheck` | Typecheck all TypeScript projects |
| `bun run verify` | CI gate: typecheck + Bun tests + Vitest + Playwright (mocked + security) |
| `bun test` | Run Bun tests |
| `bun run build:web` | Build the static Vite shell into `apps/web/dist/` |
| `bun run build:ascope` | Apply AS Lite patches, rebuild AdvantageScope Lite, and stage `dist/advantagescope/` |
| `bun run docker:build:workspace` | Build the merged openvscode-server + sim image as `coderunner-workspace` (local) |
| `bun run docker:pull:workspace` | Pull the workspace image from GHCR |
| `bun run docker:push:workspace` | Build locally and push to GHCR (escape hatch — CI normally publishes) |
| `bun run docker:cleanup` | Remove stopped managed containers |
| `bun run backup` | Snapshot the SQLite DB, allowlist, and every workspace's project + assets |
| `bun run restore` | Restore DB, allowlist, and workspace project + assets from a backup |
| `bun run migrate` | Apply pending SQLite migrations |
| `bun run migrate:status` | Show SQLite migration status |
| `bun run dev:control` | Start the Bun control plane on `:4000` with `--watch` |
| `bun run dev:web` | Start the Vite web shell on `:5173` with HMR (proxies API/WS to `:4000`) |

## Testing

Three test tiers, all runnable without Docker:

| Command | What it runs |
| --- | --- |
| `bun run test` | Bun unit/integration tests — control plane, security, property-based, metrics (~263 tests) |
| `bun run test:web` | Vitest frontend tests — hooks, components, store (~65 tests) |
| `bun run e2e` | Playwright E2E — mocked tier, full login→editor→run→telemetry flows (~55 tests) |
| `bun run e2e:security` | Playwright security specs — CSRF, XSS, response headers |
| `bun run e2e:ui` | Playwright UI mode for interactive debugging |
| `bun run e2e:debug` | Playwright debug mode with inspector |
| `bun run e2e:report` | Open the last Playwright HTML report |

The E2E mocked tier uses in-process `ControlApp` instances with fake openvscode-server, HALSim, and NT4 backends — no containers needed. Each test gets its own random port and SQLite database. See [`TESTING-PLAN.md`](TESTING-PLAN.md) for architecture details.

**Test layout:**

```text
apps/control/src/__tests__/        Bun tests: auth, runs, proxy, containers, security, property
apps/web/src/**/*.test.{ts,tsx}    Vitest tests: hooks, components, store
e2e/specs/                         Playwright specs organized by feature area
e2e/fixtures/                      Shared E2E fixtures: app, auth, fake servers, gamepad shim
```

## Operator Runbook

See [`docs/runbook.md`](docs/runbook.md) for complete setup, deployment, backup/restore, monitoring, and troubleshooting instructions.

## Observability

The control plane exposes Prometheus metrics at `GET /metrics` (auth: `METRICS_TOKEN` bearer, or admin session). HTTP latency, run lifecycle, container CPU/memory, and default process metrics are all surfaced. The recommended production setup ships these to Grafana Cloud via Grafana Alloy on the host. See [`docs/runbook.md`](docs/runbook.md) § 8 for the Alloy config and Grafana Cloud setup, and [`docs/decisions/023-metrics-and-observability.md`](docs/decisions/023-metrics-and-observability.md) for the design rationale.
