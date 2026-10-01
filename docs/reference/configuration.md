---
sidebar_position: 1
title: Configuration Reference
---

# Configuration Reference

CodeRunner is configured entirely through environment variables. Copy `.env.example` to `.env` in the repo root and edit only the values you need; the defaults are reasonable for local use. The control plane reads `.env` once at startup; restart the process to apply any changes.

:::note[Docker Compose deployments]

With the containerized control plane (the default deployment — see [decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md)) the same `.env` is read twice: Compose interpolates the `CODERUNNER_*` values (see [Docker Compose deployment](#docker-compose-deployment) below) into `docker-compose*.yml`, and the whole file is passed into the control container. The image **fixes the in-container paths** (`/data`, `/app/...`), so the **Paths** section below and the `bun run build:*` notes apply only to a from-source host run — leave them unset for a compose deployment. The control plane also auto-detects `FRC_CONTAINER_NETWORK`, `FRC_HOST_DATA_DIR`, and `FRC_CONTAINER_USER` by inspecting its own container at startup (see **Docker and Containers** below), so those need no manual setting either.

:::

## Server

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP and WebSocket listen port. |

## Paths

These rarely need changing in a standard deployment. Override them only if you need to relocate runtime data (for example, to a larger disk on a cloud VM).

| Variable | Default | Purpose |
|----------|---------|---------|
| `FRC_DATA_DIR` | `data/` (repo root) | Runtime data root: the SQLite database, student project files, allowlist, and backups all land here. |
| `FRC_DB_PATH` | `{FRC_DATA_DIR}/app.db` | Path to the SQLite database file. Defaults to `app.db` inside `FRC_DATA_DIR`. |
| `FRC_MIGRATIONS_DIR` | auto-detected from source | Path to DB migration files. Leave unset unless you are running a non-standard layout. |
| `FRC_WEB_DIST_DIR` | `apps/web/dist` | Built React web shell assets. Must exist before starting; run `bun run build:web` first. |
| `FRC_ASCOPE_DIST_DIR` | `dist/advantagescope` | Built AdvantageScope Lite assets. Populated by `bun run build:ascope`. |
| `FRC_PATHPLANNER_DIST_DIR` | `dist/pathplanner` | Prebuilt PathPlanner web assets. Populated by `bun run fetch:pathplanner` (part of `bun run build`) or `bun run fetch:dist`. |

`fetch:dist` gets the web shell and AdvantageScope from the CodeRunner release.
It gets `pathplanner-dist.tar.gz` separately from `PATHPLANNER_RELEASE_REPO`
(default `mathewdunne/pathplanner-web`) and `PATHPLANNER_RELEASE_TAG` (default:
latest release). PathPlanner is optional there — a missing artifact only warns,
and `/pathplanner/` serves a 503. `fetch:pathplanner` reads the same two
variables but treats a missing artifact as an error, which is why `bun run
build` uses it.

## Lessons Catalog

CodeRunner has two catalog sources behind one interface. When `LESSONS_CATALOG_REPO` is not set the bundled `catalog/` directory (baked into the workspace image) is used; this works offline with no configuration. Set the repo variable to pull lessons from a remote public GitHub repository instead, which lets you update lesson content without rebuilding the Docker image.

| Variable | Default | Purpose |
|----------|---------|---------|
| `LESSONS_CATALOG_REPO` | none | Remote lessons repo, as an `owner/repo` slug or full `https://` URL. When unset, the bundled catalog is used. |
| `LESSONS_CATALOG_BRANCH` | `main` | Branch to check out from the remote lessons repo. Ignored when `LESSONS_CATALOG_REPO` is unset. |
| `LESSONS_CATALOG_DIR` | `catalog/` (repo root) | Path to the bundled catalog. Only needed if you relocate the bundled catalog directory. |

See [Lessons overview](../lessons/overview.md) and [Authoring modules](../lessons/authoring-modules.md) for catalog structure.

## Auth and OAuth

OAuth credentials are required for multi-user production deployments. At least one provider (GitHub, Google, or Auth0) must be configured for login to work. Register your OAuth app at the provider and set the callback URL to `$BETTER_AUTH_URL/api/auth/callback/github`, `$BETTER_AUTH_URL/api/auth/callback/google`, or `$BETTER_AUTH_URL/api/auth/oauth2/callback/auth0`.

See [OAuth credentials](../deploying/oauth-credentials.md) for step-by-step registration instructions.

| Variable | Default | Purpose |
|----------|---------|---------|
| `BETTER_AUTH_SECRET` | `frc-local-dev-session-secret-change-me` | Session signing secret. **Change this for any production deployment.** Use a random 32+ character string. |
| `BETTER_AUTH_URL` | `http://localhost:{PORT}` | Public base URL of the app. OAuth providers redirect back to this URL; it must be reachable by the browser. |
| `GITHUB_CLIENT_ID` | none | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | none | GitHub OAuth app client secret. |
| `GOOGLE_CLIENT_ID` | none | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | none | Google OAuth client secret. |
| `AUTH0_DOMAIN` | none | Auth0 tenant domain (e.g. `myteam.us.auth0.com`). Auth0 sign-in is enabled when this, `AUTH0_CLIENT_ID`, and `AUTH0_CLIENT_SECRET` are all set. |
| `AUTH0_CLIENT_ID` | none | Auth0 application client ID. |
| `AUTH0_CLIENT_SECRET` | none | Auth0 application client secret. |
| `AUTH0_ROLES_CLAIM` | `https://coderunner/roles` | ID-token claim that holds the user's Auth0 role names. Auth0 users skip the allowlist; this claim decides whether they get in. See [Set up Auth0](../deploying/oauth-credentials.md#set-up-auth0). |
| `AUTH0_USER_ROLE_NAME` | `user` | Auth0 role name that signs in as a CodeRunner student. |
| `AUTH0_ADMIN_ROLE_NAME` | `admin` | Auth0 role name that signs in as a CodeRunner admin. |
| `CODERUNNER_DEMO_MODE` | `false` | When `1` or `true`, bypasses authentication entirely. All visitors share one admin session. Never expose a demo instance publicly. Also enabled with the `--demo` CLI flag on startup. |
| `CODERUNNER_ADMIN_EMAIL` | none | Comma-separated email addresses to bootstrap as admins with zero exec steps. Each is added to the allowlist at startup and granted the admin role on first OAuth sign-in; an existing account with that email is promoted to admin at the next startup. See [OAuth credentials](../deploying/oauth-credentials.md#the-easy-path-coderunner_admin_email). |

## Docker and Containers

| Variable | Default | Purpose |
|----------|---------|---------|
| `FRC_DOCKER_PATH` | `docker` | Path to the Docker CLI binary. Override if Docker is not on `PATH`. |
| `CODE_IMAGE` | `${CODERUNNER_IMAGE_NS}/coderunner-workspace:${CODERUNNER_TAG}` | Docker image name for student workspace containers. Set it to override the canonical name entirely. |
| `CODE_MEMORY_LIMIT` | `4096m` | Memory cap applied to each workspace container via Docker `--memory`. A cold Gradle build plus the Java language server needs most of this; setting it too low causes cgroup page-cache thrashing (the container re-reads its jars from disk in a loop) that can saturate host disk throughput. Lower with care on RAM-constrained hosts. |
| `CODE_DISK_READ_LIMIT` | `64mb` | Per-device disk read cap applied to each workspace container via Docker `--device-read-bps`, so one thrashing or scan-heavy container cannot monopolize host disk throughput and stall the VM. Devices are auto-detected from `/sys/block` when the control plane runs containerized; host/dev runs apply no limit (a VM-backed Docker daemon such as Docker Desktop has different devices than the host). Set to `0` or `off` to disable. See [decision 033](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/033-workspace-disk-read-limit.md). |
| `SIM_PORT_RANGE` | `25810-25899` | Loopback port range allocated for HALSim NT4 connections. Format: `start-end`. |
| `VSCODE_PORT_RANGE` | `33000-33099` | Loopback port range for codium-server instances. Format: `start-end`. |
| `HALSIM_PORT_RANGE` | `34000-34099` | Loopback port range for HALSim WebSocket bridges. Format: `start-end`. |
| `FRC_CONTAINER_AUTO_START` | `true` | Automatically start a student's workspace container when their session page loads. Also readable as `CONTAINER_AUTO_START`. |
| `FRC_CONTAINER_USER` | auto-detected | UID:GID for container processes. On a host/dev run, defaults to the current user's UID and GID (Linux), keeping file ownership consistent with bind-mounted project directories. Inside a container, auto-detected from the data directory's owner (`stat /data`) — see [decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md#self-inspection-zero-config-containerized-mode). Set this only to override that detection. Also configurable via `FRC_UID` + `FRC_GID` separately. |
| `FRC_CONTAINER_NETWORK` | none | Docker network that workspace containers join instead of publishing loopback host ports. Inside a container, auto-detected from the control plane's own network attachment; leave **unset** for a host/dev run (`bun run dev:control`) — a host process can't resolve container DNS names. Set this only to override detection (for example, if the container is attached to more than one user-defined network). |
| `FRC_HOST_DATA_DIR` | none | Host-side absolute path of `FRC_DATA_DIR`, used to translate workspace bind-mount sources when the control plane itself runs in a container (the Docker daemon resolves mounts against the host). Inside a container, auto-detected from the container's own bind mounts (`docker inspect`); leave unset on the host. Set this only to override detection. |

In a containerized network-mode deployment the control plane needs a way to resolve the workspace user, or it refuses to start to avoid root-owning student files on the host. A non-root `stat()` of the data directory satisfies this automatically; set `FRC_CONTAINER_USER` explicitly only if the data directory's owner isn't the uid:gid workspace containers should run as. The control container itself also runs as a non-root uid:gid (the data-dir owner) — see `CODERUNNER_UID` / `CODERUNNER_GID` / `CODERUNNER_DOCKER_GID` under [Docker Compose deployment](#docker-compose-deployment) below.

Each active student workspace uses approximately 2.5 GB of RAM at the default memory cap. See [Capacity planning](../operating/capacity.md) for host sizing guidance.

## Docker Compose deployment

These variables are consumed by `docker compose` itself (interpolated into `docker-compose*.yml`), **not** read directly by the control plane. They only apply to the containerized deployment; see [Local Deployment](../deploying/local.md) and [decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md).

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODERUNNER_TAG` | `latest` | Image tag to run for both the control and workspace images (a release tag like `v2.5.0`, or `latest`). |
| `CODERUNNER_IMAGE_NS` | `ghcr.io/mathewdunne` | Registry + owner for both coderunner images. Forks publishing their own images set this once. Unlike the other variables in this table it is also read by the control plane and the image build/pull script, so the same `.env` line covers every consumer. |
| `CODERUNNER_HOST_DATA_DIR` | `./data` (in the checkout) | Host path of the data directory, bind-mounted into the control container at `/data`. Compose resolves `./data` against the project directory. Set this to relocate the data directory (for example, onto a mounted disk); the control plane derives the matching `FRC_HOST_DATA_DIR` itself by inspecting its own container, so this variable does not need to be passed through by hand. |
| `CODERUNNER_UID` | `1000` | uid the **control container** runs as (compose `user:`). Should own `CODERUNNER_HOST_DATA_DIR` so `./data` stays host-owned rather than root-owned. The `1000` default is correct for the first user on most single-user hosts. Distinct from `FRC_CONTAINER_USER`, which governs the workspace siblings. |
| `CODERUNNER_GID` | `1000` | gid the control container runs as (paired with `CODERUNNER_UID` in compose `user:`). |
| `CODERUNNER_DOCKER_GID` | `0` | Gid owning the bind-mounted Docker socket, added to the non-root control process as a supplementary group (compose `group_add:`) so it can reach it. The `0` default matches Docker Desktop on macOS and native Windows, whose socket is root-owned, so neither needs a setting here. **Linux and WSL2** own the socket by the `docker` group instead and must set this — that includes Docker Desktop's WSL2 integration, which behaves like a native Linux host. Find it with `stat -c '%g' /var/run/docker.sock` (stock Debian/Ubuntu installs often use `999`/`998`). |
| `COMPOSE_FILE` | none | Production VM only: selects the prod stack (`docker-compose.yml:docker-compose.prod.yml`) so a plain `docker compose up -d` runs Caddy + Alloy too. |

## Run Lifecycle

These control how long the control plane waits during a build-and-run cycle before giving up.

| Variable | Default | Purpose |
|----------|---------|---------|
| `RUN_BUILD_TIMEOUT_MS` | `90000` | Maximum time (ms) to wait for `gradle build` to complete before reporting a build timeout. |
| `SIM_STARTUP_TIMEOUT_MS` | `30000` | Maximum time (ms) to wait for the simulator to become ready after a successful build. |

The first build is always slower: Gradle downloads dependencies and warms up the JVM. Subsequent builds hit the cache and complete in a few seconds. See [FAQ: why is the first run slow?](./faq.md#why-is-the-first-build-or-run-slow) for details.

## Idle Management

The idle manager periodically checks active containers and stops those that have not been used recently. This frees host RAM between sessions without requiring manual intervention.

| Variable | Default | Purpose |
|----------|---------|---------|
| `IDLE_STOP_MINUTES` | `30` | Stop a workspace container after this many minutes of inactivity. |
| `IDLE_CHECK_INTERVAL_MS` | `60000` | How often (ms) the idle sweep runs. |

## Admin and Metrics

| Variable | Default | Purpose |
|----------|---------|---------|
| `ADMIN_TOKEN` | none | Bearer token accepted by `/admin/*` endpoints as an alternative to an admin user session. Useful as a break-glass bootstrap token before any admin user has signed in. Leave unset to require a signed-in admin session. |
| `METRICS_TOKEN` | none | Bearer token accepted for scraping `GET /metrics`. When set, scrapers send `Authorization: Bearer <token>`. Leave unset to require an admin user session instead. |
| `MAX_ACTIVE_CONTAINERS` | `10` | Hard cap on simultaneously running workspace containers. New workspace requests beyond this limit are rejected until a slot is freed. |

See [Monitoring](../operating/monitoring.md) for the `/metrics` Prometheus endpoint.

## Logging

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `debug` (non-test), `warning` (test) | Control plane log verbosity. Valid values: `trace`, `debug`, `info`, `warning`, `error`, `fatal`. The alias `warn` is accepted. |
| `LOG_FORMAT` | `text` | Log output format. `text` is colored and human-readable for local development. `json` emits NDJSON for log shipping (for example, Grafana Alloy to Loki in cloud deployments). |

## Demo mode and the `--demo` flag

Demo mode (`CODERUNNER_DEMO_MODE=1`) can also be activated at startup with the command-line flag:

```bash
bun run start -- --demo
```

The flag takes precedence and sets the same behavior: authentication is skipped, every visitor is the same admin user, and the UI shows a warning banner. Use demo mode only on your own machine or a trusted local network; it has no privacy boundary between visitors.

## How environment is loaded

The control plane reads `.env` from the repo root at startup using Bun's built-in dotenv support. Variables already set in the shell environment take precedence over `.env` values. There is no hot-reload; restart the process after any change.

On a cloud VM the `.env` file is regenerated on every boot by `render-env.sh`, so hand-edits are overwritten on the next reboot. Make permanent changes in the cloud-init template instead. See [Google Cloud deployment](../deploying/gcloud.md) for details.

---

## Notes on .env.example vs config.ts

Three variables appear in `.env.example` but are not in `config.ts`'s `ControlConfig` struct because they are read outside of it:

- `PORT`: read directly by `apps/control/src/main.ts` as the listen port; also feeds the `BETTER_AUTH_URL` default in `config.ts`.
- `LOG_FORMAT`: read directly by `apps/control/src/logging.ts`; not part of `ControlConfig`.
- `METRICS_TOKEN`: read directly by `apps/control/src/app.ts` to gate the `/metrics` endpoint; not part of `ControlConfig`.

All three are real, documented, and functional; they are just not stored in the config object.
