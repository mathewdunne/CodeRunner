# FRC Web Simulator

A browser-based IDE for learning FRC robot programming. Students write Java, run a WPILib simulation, and view telemetry through AdvantageScope Lite.

Status: **V1 complete; V2 in progress.** V2 replaces the custom Monaco/JDT LS editor stack with per-student openvscode-server containers; see [`V2-Design.md`](V2-Design.md). V2 Stage 0 through Stage 3 are implemented, and the next planned stage is Stage 4, the web shell swap.

The V2 editor spike is accepted in [`docs/decisions/011-v2-editor-spike.md`](docs/decisions/011-v2-editor-spike.md). Do not spend future-stage verification on upstream extension-owned behavior such as `redhat.java` auto-import, hover, diagnostics, or F12/Ctrl-click into WPILib classes unless the pinned editor or extension versions change. Future V2 checks should focus on this project’s integration behavior: proxying, auth, persistence, run orchestration, logs, telemetry, and cleanup.

See [`docs/runbook.md`](docs/runbook.md) for V1 operator setup, [`docs/manual-tests.md`](docs/manual-tests.md) for V1 acceptance test procedures, and [`V1-Design.md`](V1-Design.md) for V1 architecture. The working MVP has been archived under `mvp/` for reference.

## Prerequisites

- Bun 1.3.13 or newer
- Docker, for sim, LSP, and V2 code container tasks
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
apps/web/                      React + Vite browser shell served by the control plane
packages/contracts/            Shared schemas, message types, and path rules
containers/code/               V2 merged openvscode-server + sim container
templates/wpilib-java-command/ WPILib Java command-based starter template
scripts/                       Bun utility scripts
patches/advantagescope/        Source-level AS Lite patches
vendor/AdvantageScope/         Pinned upstream submodule
mvp/                           Archived MVP implementation and docs
```

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Install V1 workspace dependencies and write `bun.lock` |
| `bun run typecheck` | Typecheck all V1 TypeScript projects |
| `bun test` | Run Bun tests |
| `bun run build:web` | Build the static Vite shell into `apps/web/dist/` |
| `bun run build:ascope` | Apply AS Lite patches, rebuild AdvantageScope Lite, and stage `dist/advantagescope/` |
| `bun run verify:ascope` | Smoke-check the staged AS Lite bundle and `/scope/` serving contract |
| `bun run docker:build:code` | Build the V2 merged openvscode-server + sim image as `frc-code:v2` |
| `bun run verify:v1:two-user` | Run the real-Docker Alice/Bob V1 two-user smoke |
| `bun run verify:v1:three-user` | Run the 3-user classroom smoke with queue/LSP isolation |
| `bun run measure` | Report host resources and container memory, extrapolate for 10 students |
| `bun run backup` | Back up all workspace project directories |
| `bun run restore` | Restore workspace projects from a backup |
| `bun run docker:cleanup` | Remove stopped V1 managed containers |
| `bun run migrate` | Apply pending SQLite migrations |
| `bun run migrate:status` | Show SQLite migration status |
| `bun run dev:control` | Start the V1 Bun control plane on `:4000` |
| `bun run dev:web` | Start the Vite web shell directly for frontend-only work |

## Operator Runbook

See [`docs/runbook.md`](docs/runbook.md) for complete setup, deployment, backup/restore, monitoring, and troubleshooting instructions.

The source of truth for the V1 rewrite is [`V1-Design.md`](./V1-Design.md). The old MVP source is intentionally not evolved in place; copy proven behavior from `mvp/` only when a V1 task calls for it.
