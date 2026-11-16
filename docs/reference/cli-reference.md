---
sidebar_position: 2
title: CLI Reference
---

# CLI Reference

All scripts are run from the repo root with `bun run NAME` and require Bun 1.4.4 or newer — this is the interface for a from-source host checkout (including the host dev loop). For a `docker compose` deployment, the equivalent ops surface is the `coderunner` CLI baked into the control image; see [Containerized ops: the `coderunner` CLI](#containerized-ops-the-coderunner-cli) below.

## Running the App

| Script | What it does |
|--------|-------------|
| `start` | Applies pending database migrations, then starts the control plane. The normal way to run CodeRunner from source. |
| `demo` | Applies migrations, then starts the control plane in demo mode (`--demo`), from source. Auth is bypassed and every visitor shares one admin workspace — for local evaluation only. See [Quick Start (Installation)](../quick-start.md). |
| `demo:docker` | Runs the containerized demo stack: `CODERUNNER_DEMO_MODE=1 docker compose up`. The containerized equivalent of `demo`. |
| `dev:control` | Starts the control plane with `--watch` so it restarts automatically when source files change. Use during backend development. Always runs in port mode, regardless of `FRC_CONTAINER_NETWORK`. |
| `dev:web` | Starts the Vite dev server for the React web shell with HMR. Use alongside `dev:control` during frontend development. |

## Containerized ops: the `coderunner` CLI

In a `docker compose` deployment the scripts documented on this page are baked
into the control image and reachable through one dispatching entrypoint,
`coderunner <subcommand>`, installed at `/usr/local/bin/coderunner`
(`containers/control/entrypoint.sh`). Two invocation forms work, for different
reasons:

- `docker compose exec control coderunner <subcommand>` — runs inside the
  already-running `control` container. `exec` bypasses the image
  `ENTRYPOINT` entirely, so this form only works because `coderunner` is also
  installed on `PATH`, not because it's the entrypoint.
- `docker compose run --rm control <subcommand>` — starts a fresh one-off
  container from the same image; `run` replaces `CMD`, so the entrypoint
  itself does the dispatching. Use this form when the control plane is
  stopped (for example, `restore`), since `exec` requires a running container.

| `coderunner` subcommand | Equivalent `bun run` script (from-source) | What it does |
|---|---|---|
| `serve` (default; also plain `docker compose up`) | `start` | Applies migrations, then starts the server as PID 1. |
| `backup` | `backup` | See [Backup and Restore](#backup-and-restore). |
| `restore` | `restore` | See [Backup and Restore](#backup-and-restore). Backup directory paths are resolved inside `/data`. |
| `allowlist` | `allowlist:list` / `allowlist:add` / `allowlist:remove` | See [Users and Access](#users-and-access). |
| `users` | `users:list` / `users:promote` / `users:demote` | See [Users and Access](#users-and-access). |
| `audit-prune` | `audit:prune` | See [Database](#database). |
| `rebuild-workspaces` | `docker:rebuild-workspaces` | See [Docker Images and Containers](#docker-images-and-containers). |
| `cleanup` | `docker:cleanup` | See [Docker Images and Containers](#docker-images-and-containers). |
| `migrate` | `migrate` / `migrate:status` | See [Database](#database). |
| `help` / `--help` | — | Prints the subcommand list. |
| anything else | — | Passed through verbatim (`exec "$@"`) — for example, `docker compose run --rm control bash` opens a shell. |

Example: `bun run allowlist:add coach@example.com` on a from-source checkout
is `docker compose exec control coderunner allowlist add coach@example.com`
in a compose deployment. Setting `CODERUNNER_ADMIN_EMAIL` before first boot
avoids needing either form for the first admin — see
[OAuth credentials](../deploying/oauth-credentials.md#the-easy-path-coderunner_admin_email).

## Build

| Script | What it does |
|--------|-------------|
| `build` | Full production build: builds the React web shell, builds AdvantageScope Lite assets, downloads the PathPlanner web dist, then pulls the workspace Docker image from GHCR. Run this before `start` on a fresh checkout. Fails if the PathPlanner artifact cannot be downloaded — a production build ships every advertised feature. |
| `build:web` | Builds only the React web shell into `apps/web/dist`. |
| `build:ascope` | Builds only the AdvantageScope Lite assets into `dist/advantagescope`. Requires emscripten and the AdvantageScope submodule. |
| `fetch:dist` | Downloads the web shell and AdvantageScope from a CodeRunner release, plus an optional PathPlanner web build. Pass `--tag vX.Y.Z` (or set `DEMO_RELEASE_TAG`) to pin the CodeRunner release; set `DEMO_RELEASE_REPO` to use a fork. A missing PathPlanner artifact only warns here — `/pathplanner/` then serves a 503. |
| `fetch:pathplanner` | Downloads only the PathPlanner web dist into `dist/pathplanner`, and fails if it is unavailable. Called by `build`. Override the source with `PATHPLANNER_RELEASE_REPO`/`PATHPLANNER_RELEASE_TAG`. |
| `setup:demo` | One-step demo setup: pulls the workspace image, then runs `fetch:dist`. Pair with `demo`. |
| `clean` | Deletes built output directories (`apps/web/dist`, `dist/advantagescope`, and `dist/pathplanner`). Does not touch runtime data under `data/`. |

## Docs Site

| Script | What it does |
|--------|-------------|
| `docs:install` | Installs Docusaurus dependencies inside `website/`. Run once before using the docs scripts. |
| `docs:dev` | Starts the Docusaurus dev server with live reload for editing documentation. |
| `docs:build` | Builds the static docs site into `website/build/`. |

## Database

| Script | What it does |
|--------|-------------|
| `migrate` | Applies all pending database migrations. Called automatically by `start`. Run manually after pulling a new release before restarting the control plane. |
| `migrate:status` | Shows which migrations have been applied and which are pending, without making any changes. |
| `audit:prune` | Deletes audit log entries older than a given date. Usage: `bun run audit:prune --before YYYY-MM-DD [--dry-run]`. Use to keep the database from growing unbounded over a long season. |

## Docker Images and Containers

| Script | What it does |
|--------|-------------|
| `docker:pull:workspace` | Pulls the workspace image (`${CODERUNNER_IMAGE_NS:-ghcr.io/mathewdunne}/coderunner-workspace:${CODERUNNER_TAG:-latest}`) from the registry. Called automatically by `build`. |
| `docker:build:workspace` | Builds the workspace image locally from `containers/code/Dockerfile`, tagged with the same canonical name the pull uses. Running student containers move to a rebuild when the control plane restarts (`docker compose restart control`, or restart `dev:control`), or after `docker:rebuild-workspaces`. Use when iterating on the container itself; normal deployments pull the prebuilt image instead. |
| `docker:build:control` | Builds the control-plane image locally. It builds the web shell and AdvantageScope, and makes a best-effort download of the latest prebuilt PathPlanner web artifact (release builds pass a pinned `PATHPLANNER_DIST_TAG` instead, which makes that download required). Normal deployments pull the published image instead. |
| `docker:cleanup` | Removes all stopped managed containers (those with the `frc-sim.managed=true` label). Safe to run while the control plane is up. Accepts `--dry-run` to preview what would be removed. |
| `docker:rebuild-workspaces` | Removes all running and stopped managed V2 workspace containers and clears their database leases, forcing fresh containers on next login. Student project files are untouched; they are bind-mounted and survive container removal. Accepts `--dry-run`. Not needed when updating CodeRunner: after the update restarts the control plane, it recreates containers that are on an older workspace image automatically. |

## Users and Access

| Script | What it does |
|--------|-------------|
| `allowlist:list` | Prints the current email and domain allowlist. An empty allowlist blocks all OAuth sign-ins. |
| `allowlist:add` | Adds an email address or domain to the allowlist. Usage: `bun run allowlist:add coach@example.com` or `bun run allowlist:add example.com` (domain allows all addresses at that domain). |
| `allowlist:remove` | Removes an entry from the allowlist. Usage: `bun run allowlist:remove coach@example.com`. |
| `users:list` | Lists all users in the database with their name, email, role, and workspace slug. |
| `users:promote` | Sets a user's role to `admin`. Usage: `bun run users:promote coach@example.com`. |
| `users:demote` | Sets a user's role to `student`. Usage: `bun run users:demote coach@example.com`. |

## Backup and Restore

| Script | What it does |
|--------|-------------|
| `backup` | Backs up the SQLite database, allowlist, and all student project and assets directories to a timestamped directory under `data/backups/`. Accepts `--data-dir`, `--output`, and `--projects-only` flags. Safe to run against a running instance. |
| `restore` | Restores a backup created by `backup`. Usage: `bun run restore -- <backup-dir>`. Accepts `--workspace <id>` to restore a single workspace, plus `--skip-db`, `--skip-allowlist`, `--skip-assets`, and `--dry-run`. Stop the control plane before restoring to avoid conflicts. |

## Quality and Tests

| Script | What it does |
|--------|-------------|
| `typecheck` | Runs `tsc --noEmit` across all packages. Use to catch type errors before committing. |
| `lint` | Runs Biome linting across the codebase (read-only). |
| `lint:fix` | Runs Biome linting and applies safe auto-fixes. |
| `format` | Runs Biome formatter and writes changes. |
| `check` | Runs Biome lint and format checks together (read-only, suitable for CI). |
| `check:fix` | Runs Biome lint, format, and import organization and writes all safe fixes. Run this before finalizing any code change. |
| `verify` | Full CI gate: `biome ci`, typecheck, all tests, and E2E. Must pass before merging. |
| `test` | Runs Bun unit and integration tests for the control plane and shared packages. No Docker required. |
| `test:web` | Runs Vitest frontend tests for the React web shell. No Docker required. |
| `e2e` | Runs Playwright E2E tests against an in-process mocked app (~55 tests). No Docker required. |
| `e2e:ui` | Opens the Playwright UI for interactive E2E debugging. |
| `e2e:debug` | Runs E2E tests with `PWDEBUG=1` for step-through debugging. |
| `e2e:security` | Runs Playwright security specs (~8 tests): CSRF, XSS, response headers. |
| `e2e:workspace-java` | Runs the targeted real-container VSCodium/JDT/Java/WPILib smoke. Requires Docker and a locally built workspace image; intentionally outside `verify`. |
| `e2e:report` | Opens the last Playwright HTML report. |
