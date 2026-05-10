# FRC Web Simulator

A browser-based IDE for learning FRC robot programming. Students write Java in a full VS Code editor (openvscode-server), run a WPILib simulation, and view telemetry through AdvantageScope Lite.

Status: **V2 complete.** Each student gets a per-student container running openvscode-server with the redhat.java and wpilibsuite.vscode-wpilib extensions, providing auto-import, Ctrl-click into library classes, diagnostics, and full VS Code features. See [`V2-Design.md`](V2-Design.md) for architecture.

See [`docs/runbook.md`](docs/runbook.md) for operator setup, [`docs/manual-tests.md`](docs/manual-tests.md) for acceptance test procedures, and [`V2-Design.md`](V2-Design.md) for architecture. The V1 design is preserved in [`V1-Design.md`](V1-Design.md). The working MVP has been archived under `mvp/` for reference.

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
| `bun install` | Install workspace dependencies and write `bun.lock` |
| `bun run typecheck` | Typecheck all TypeScript projects |
| `bun test` | Run Bun tests |
| `bun run build:web` | Build the static Vite shell into `apps/web/dist/` |
| `bun run build:ascope` | Apply AS Lite patches, rebuild AdvantageScope Lite, and stage `dist/advantagescope/` |
| `bun run verify:ascope` | Smoke-check the staged AS Lite bundle and `/scope/` serving contract |
| `bun run docker:build:code` | Build the V2 merged openvscode-server + sim image as `frc-code:v2` |
| `bun run verify:v2:two-user` | Run the real-Docker Alice/Bob V2 two-user smoke |
| `bun run verify:v2:three-user` | Run the 3-user classroom smoke with queue behavior |
| `bun run measure` | Report host resources and container memory, extrapolate for 10 students |
| `bun run backup` | Back up all workspace project directories |
| `bun run restore` | Restore workspace projects from a backup |
| `bun run docker:cleanup` | Remove stopped managed containers |
| `bun run migrate` | Apply pending SQLite migrations |
| `bun run migrate:status` | Show SQLite migration status |
| `bun run dev:control` | Start the Bun control plane on `:4000` |
| `bun run dev:web` | Start the Vite web shell directly for frontend-only work |

## Operator Runbook

See [`docs/runbook.md`](docs/runbook.md) for complete setup, deployment, backup/restore, monitoring, and troubleshooting instructions.
