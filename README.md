# FRC Web Simulator V1

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, run a WPILib simulation, and view telemetry through AdvantageScope Lite.

Status: V1-0 through V1-2 are implemented. The current root contains the Bun workspace scaffold, shared contracts, SQLite migrations, signed-cookie login/session flow, first-login workspace creation from the WPILib Java command template, authenticated workspace routing, the static React/Vite shell, session/tree APIs, and heartbeat tracking. The working MVP has been archived under `mvp/` for reference.

## Prerequisites

- Bun 1.3.13 or newer
- Docker, for later sim and LSP container tasks
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
apps/control/                  Bun control plane with login, sessions, storage, routing, and V1 APIs
apps/web/                      React + Vite browser shell served by the control plane
packages/contracts/            Shared V1 schemas, message types, and path rules
templates/wpilib-java-command/ WPILib Java command-based starter template
scripts/                       V1 utility scripts
patches/advantagescope/        Future AS Lite source patches
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
| `bun run migrate` | Apply pending SQLite migrations |
| `bun run migrate:status` | Show SQLite migration status |
| `bun run dev:control` | Start the V1-2 Bun control plane on `:4000` |
| `bun run dev:web` | Start the Vite web shell directly for frontend-only work |

The source of truth for the V1 rewrite is [`V1-Design.md`](./V1-Design.md). The old MVP source is intentionally not evolved in place; copy proven behavior from `mvp/` only when a V1 task calls for it.
