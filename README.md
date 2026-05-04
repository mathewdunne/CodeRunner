# FRC Web Simulator V1

A browser-based IDE for learning FRC robot programming. Students write Java in Monaco, run a WPILib simulation, and view telemetry through AdvantageScope Lite.

Status: V1 implementation has started. The current root is the V1 scaffold from `V1-Design.md` task V1-0. The working MVP has been archived under `mvp/` for reference.

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
apps/control/                  Bun control plane placeholder
apps/web/                      React + Vite browser shell placeholder
packages/contracts/            Shared V1 contract placeholder
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
| `bun run typecheck` | Typecheck all placeholder V1 TypeScript projects |
| `bun test` | Run Bun tests once they exist |
| `bun run dev:control` | Start the placeholder Bun control plane on `:4000` |
| `bun run dev:web` | Start the placeholder Vite web shell |

The source of truth for the V1 rewrite is [`V1-Design.md`](./V1-Design.md). The old MVP source is intentionally not evolved in place; copy proven behavior from `mvp/` only when a V1 task calls for it.
