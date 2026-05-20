# CodeRunner V2 — Operator Runbook

This runbook covers deploying and operating CodeRunner V2 on a classroom machine. For architecture details, see [`V2-Design.md`](../V2-Design.md).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Initial Setup](#2-initial-setup)
3. [Starting the App](#3-starting-the-app)
4. [Stopping the App](#4-stopping-the-app)
5. [Configuration](#5-configuration)
6. [Backup and Restore](#6-backup-and-restore)
7. [Cache Cleanup](#7-cache-cleanup)
8. [Monitoring](#8-monitoring)
9. [Common Failures and Recovery](#9-common-failures-and-recovery)
10. [Host Sizing](#10-host-sizing)
11. [Project Import](#11-project-import)
12. [Container Concurrency Cap](#12-container-concurrency-cap)
13. [Audit Log](#13-audit-log)
14. [Cloudflare Pages (optional offline screen)](#14-cloudflare-pages-optional-offline-screen)

---

## 1. Prerequisites

| Requirement | Minimum | Recommended |
| --- | --- | --- |
| **Bun** | 1.3.13+ | Latest stable |
| **Docker** | Docker Engine 24+ or Docker Desktop | Native Linux Docker for best performance |
| **Git** | 2.x with submodule support | — |
| **RAM** | 16 GB (3–5 students) | 32 GB (10 students) |
| **CPU** | 4 cores | 6+ cores |
| **Disk** | 20 GB free | 50+ GB free |
| **OS** | Linux (Ubuntu 22.04+), Windows with WSL2/Docker Desktop | Ubuntu 22.04+ native |
| **Network** | LAN access for students | — |

On Windows, use PowerShell 7 (`pwsh`) for all commands.

---

## 2. Initial Setup

### 2.1 Clone and initialize

```bash
git clone <repo-url> CodeRunner
cd CodeRunner
git submodule update --init --recursive
bun install
```

### 2.2 Build the code container image

```bash
bun run docker:build:workspace
```

The first build downloads WPILib/Gradle dependencies and takes 5–15 minutes. Subsequent builds use Docker layer cache and are fast.

### 2.3 Build web assets

```bash
bun run build:web
bun run build:ascope
```

### 2.4 Configure environment

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

**At minimum**, change the Better Auth secret and configure OAuth providers:

```bash
# .env
BETTER_AUTH_SECRET=your-random-secret-string-here

# OAuth — register apps at the provider and fill in these values.
# At least one provider (GitHub or Google) must be configured for login.
BETTER_AUTH_URL=http://localhost:4000
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Registering OAuth apps for local development:**

- **GitHub:** Go to *Settings → Developer settings → OAuth Apps → New*. Set
  the callback URL to `http://localhost:4000/api/auth/callback/github`.
- **Google:** Go to *Google Cloud Console → APIs & Services → Credentials →
  Create OAuth client ID* (type: Web application). Add
  `http://localhost:4000/api/auth/callback/google` as an authorised redirect URI.

Add at least one coach/admin email or team domain before testing OAuth:

```bash
bun run allowlist:add coach@frcteam.org
# or
bun run allowlist:add frcteam.org
```

After the first coach signs in, promote them:

```bash
bun run users:promote coach@frcteam.org
```

If only one provider is configured, users will see one working sign-in option.

See [Configuration](#5-configuration) for all options.

### 2.5 Run migrations

```bash
bun run migrate
```

### 2.6 Verify the setup

```bash
bun run check
bun run typecheck
bun run test
```

The integration test suite covers session isolation, multi-workspace routing, run log streaming, editor proxying, NT4 proxying, lifecycle reconciliation, and admin operations.

### 2.7 Monitor host resources

Per-container CPU and memory are exposed at `/metrics` by the control plane (collected every 15 s by `metrics-collector.ts`) and scraped into Grafana. Use the Grafana dashboards under `grafana/` for live host and container sizing data.

---

## 3. Starting the App

### Production

```bash
bun run start
```

This applies pending migrations and then serves the control plane. Use as the `ExecStart` of a systemd service.

### Dev (one-command)

```bash
bun run dev:control
```

The control plane starts on port 4000 (or the `PORT` env var). It:
- Runs pending database migrations
- Reconciles existing Docker containers from labels
- Starts the idle sweep timer
- Logs the active configuration summary

Students connect to `http://<host-ip>:4000/` in their browsers.

### What happens on first student login

1. Student enters a classroom name on the login page.
2. A user, workspace, and project directory are created.
3. The WPILib Java command-based template is copied into their workspace.
4. A signed session cookie is set.
5. The browser redirects to `/u/<workspaceSlug>/`.
6. A code container (merged sim + editor) is started in the background.

### Verify the app is running

Open `http://localhost:4000/` in a browser. You should see the login page.

Check admin status:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/admin/status
```

---

## 4. Stopping the App

### Graceful stop

Press `Ctrl+C` in the terminal running the control plane. This:
- Stops the idle sweep timer
- Closes WebSocket connections

**Containers continue running.** They will be reconciled on next startup.

### Stop containers too

To stop all student containers after shutting down the control plane:

```bash
bun run docker:cleanup
```

This removes stopped (exited) managed containers. To also stop running ones, use the admin API before shutdown:

```bash
# Stop all workspaces
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST http://localhost:4000/admin/workspaces/<workspaceId>/stop-containers
```

Or stop containers manually:

```bash
docker stop $(docker ps -q --filter label=frc-sim.managed=true)
```

### Between class sessions

Idle teardown handles containers automatically after the configured timeout (default 30 min). No manual action needed for normal classroom use.

---

## 5. Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and customize.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/WS listen port |
| `FRC_DATA_DIR` | `data` | Runtime data root |
| `FRC_DB_PATH` | `data/app.db` | SQLite database path |
| `FRC_TEMPLATE_DIR` | `templates/wpilib-java-command` | Starter project template |
| `FRC_MIGRATIONS_DIR` | auto-detected | Database migrations directory |
| `FRC_WEB_DIST_DIR` | `apps/web/dist` | Built web shell assets |
| `FRC_ASCOPE_DIST_DIR` | `dist/advantagescope` | Built AdvantageScope Lite assets |
| `BETTER_AUTH_SECRET` | *(dev default)* | **Change this!** Better Auth cookie/session secret |
| `FRC_DOCKER_PATH` | `docker` | Docker binary path |
| `FRC_CONTAINER_USER` | auto-detected | UID:GID used inside code containers |
| `FRC_UID` / `FRC_GID` | *(none)* | Alternative UID/GID inputs when `FRC_CONTAINER_USER` is unset |
| `FRC_CONTAINER_AUTO_START` | `true` | Start the code container when a workspace opens |
| `CODE_IMAGE` | `coderunner-workspace` | Docker image for merged code containers |
| `CODE_MEMORY_LIMIT` | `2560m` | Memory cap per code container |
| `SIM_PORT_RANGE` | `25810-25899` | Loopback port range for sim NT4 |
| `VSCODE_PORT_RANGE` | `33000-33099` | Loopback port range for openvscode-server |
| `RUN_BUILD_TIMEOUT_MS` | `90000` | Build timeout before a run fails |
| `SIM_STARTUP_TIMEOUT_MS` | `30000` | Sim readiness timeout after build startup |
| `IDLE_STOP_MINUTES` | `30` | Stop containers after N min idle |
| `IDLE_CHECK_INTERVAL_MS` | `60000` | Idle sweep interval |
| `HALSIM_PORT_RANGE` | `34000-34099` | Loopback port range for HALSim WebSocket |
| `MAX_ACTIVE_CONTAINERS` | `10` | Maximum concurrent running code containers (admission control cap) |
| `ADMIN_TOKEN` | *(none)* | Optional break-glass bearer token for admin API bootstrap; unset = admin session only |
| `BETTER_AUTH_URL` | `http://localhost:4000` | Base URL for Better Auth callbacks/redirects |
| `GITHUB_CLIENT_ID` | *(none)* | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | *(none)* | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | *(none)* | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | *(none)* | Google OAuth client secret |
| `LOG_LEVEL` | `debug` (`warning` under tests) | Control-plane log verbosity: `trace`, `debug`, `info`, `warning`, `error`, `fatal` |

### Tuning for constrained hosts

For a 16 GB machine with 3–5 students:

```bash
CODE_MEMORY_LIMIT=2048m
IDLE_STOP_MINUTES=15
```

### Tuning for large classrooms

For a 32+ GB machine with 10 students:

```bash
CODE_MEMORY_LIMIT=2560m
```

See `.env.example` for the complete list of options.

---

## 6. Backup and Restore

### What to back up

Only `data/users/<workspaceId>/project/` contains student work. Everything else is regenerable:

| Path | Contains | Back up? |
| --- | --- | --- |
| `data/app.db` | User, workspace, session, audit, admin role metadata | **Yes** |
| `data/allowlist.json` | Auth allowlist (emails permitted to sign in) | **Yes** |
| `data/users/*/project/` | Student Java source code | **Yes** |
| `data/users/*/assets/` | Uploaded AdvantageScope assets per workspace | **Yes** |
| `data/users/*/home/` | Gradle cache, tool state, vscode user data | No (regenerated on container start) |
| `data/users/*/jdtls-data/` | Java language server state | No (regenerated) |
| `data/users/*/logs/` | Build/run log history | No (transient, safe to prune) |

### Create a backup

```bash
bun run backup
```

Creates a timestamped snapshot under `data/backups/YYYY-MM-DD-HHmmss/`:

```
data/backups/2026-05-16-151038/
  app.db                              # SQLite online-backup snapshot
  allowlist.json                      # raw copy
  workspaces/
    <workspaceId>/
      project.tar.gz
      assets.tar.gz                   # if assets/ exists
```

Useful flags:

```bash
bun run backup -- --output /path/to/backup     # custom output directory
bun run backup -- --projects-only              # legacy mode: skip DB, allowlist, assets
```

The `app.db` snapshot uses SQLite's online backup API (`Database.serialize()`), so it's safe to run while the control plane is up — you'll get a consistent view of committed state. For project/assets archives, prefer to stop the control plane or take the backup when no students are actively saving files.

### Restore from backup

**Stop the control plane first**, then:

```bash
bun run restore -- <backup-dir>
```

By default this restores DB, allowlist, and every workspace's project + assets. Restore is destructive — the existing files are overwritten.

Useful flags:

```bash
bun run restore -- <backup-dir> --dry-run                      # preview only
bun run restore -- <backup-dir> --workspace ws_abc123          # one workspace; implies --skip-db --skip-allowlist
bun run restore -- <backup-dir> --skip-db                      # keep current DB
bun run restore -- <backup-dir> --skip-allowlist               # keep current allowlist
bun run restore -- <backup-dir> --skip-assets                  # only project files
```

Legacy backups created with `--projects-only` (or by older versions of `backup.ts`) restore the per-workspace project files only — `--skip-db` and `--skip-allowlist` are automatically no-ops because the backup doesn't include them.

### Local-dev → VM migration

To copy your local state up to the GCE VM:

```bash
# on the laptop, after stopping local dev
bun run backup
rsync -a data/backups/<timestamp>/ user@vm:/path/to/coderunner/data/backups/<timestamp>/

# on the VM (with the control plane stopped)
bun run restore -- data/backups/<timestamp>
bun run start
```

### Recommended backup schedule

- **Daily** during active classroom use (before class or end of day)
- **Before** any Docker image rebuild or host OS update
- **Before** running `restore` (back up the current state first!)

---

## 7. Cache Cleanup

Student caches grow over time. These are safe to prune when containers are stopped.

### Remove stopped containers

```bash
bun run docker:cleanup
```

Dry run first:

```bash
bun run docker:cleanup -- --dry-run
```

### Prune Gradle/tool caches

For a specific workspace (stop its containers first):

```bash
rm -rf data/users/<workspaceId>/home/
mkdir -p data/users/<workspaceId>/home
```

These directories are recreated automatically on next container start.

### Prune run logs

```bash
rm -rf data/users/<workspaceId>/logs/runs/*
```

### Prune all regenerable data

For all workspaces (containers must be stopped):

```bash
for dir in data/users/*/; do
  rm -rf "$dir/home" "$dir/logs"
  mkdir -p "$dir/home" "$dir/logs/runs"
done
```

### Docker system cleanup

```bash
docker system prune -f          # Remove unused containers, networks, images
docker builder prune -f         # Remove build cache
```

---

## 8. Monitoring

### Admin status API

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/admin/status | jq .
```

Returns:
- All workspaces with code container state
- Idle flags per workspace
- Active build count
- Configured limits

### Resource measurement

Per-container CPU/memory and host-level gauges are exported at `/metrics` and scraped into Grafana. See `grafana/` for the dashboards. Raw `docker stats` is still available locally if needed:

```bash
docker stats --filter label=frc-sim.managed=true --no-stream
```

### Docker container status

```bash
# All managed containers
docker ps --filter label=frc-sim.managed=true

# Container resource usage
docker stats --filter label=frc-sim.managed=true --no-stream
```

### Watch for issues

- **High memory:** `docker stats` shows containers near their limit → OOM risk
- **Many active builds:** `/admin/status` activeBuilds is high while students are all starting sims → check CPU headroom and build timeouts

### Control-plane logs

The control plane emits structured logs to stdout/stderr (errors and fatals go to stderr). Format:

```
14:23:01.482 INFO  [control.runs]       run started workspaceId=alice-1 runId=run_abc
```

Set verbosity with `LOG_LEVEL` (`trace`, `debug`, `info`, `warning`, `error`, `fatal`). Default is `debug`; the test suite forces `warning` to keep CI output tidy. Categories follow `control.<subsystem>` — `boot`, `http`, `ws`, `proxy`, `runs`, `containers`, `idle`, `auth`, `admin`, `workspace`, `halsim`, `nt4`, `gamepad`, `imports`, `migrate`. Pipe stdout into a file or `tee` for a session capture; ANSI colors are auto-disabled when output isn't a TTY.

### Prometheus metrics (`/metrics`)

The control plane exposes Prometheus-format metrics at `GET /metrics`. Series include:

- `http_request_duration_seconds{method, route, status_class}` — request latency (route is templated to keep cardinality bounded, e.g. `/u/:slug/api/sim/status`).
- `http_requests_in_flight` — concurrency. Spikes here while latency rises indicate the Bun event loop is bogged down.
- `proxy_upstream_duration_seconds{upstream, outcome}` — latency of upstream HTTP fetches (`vscode`, `nt4`).
- `run_build_duration_seconds` — compile + boot time per run.
- `run_active_duration_seconds{terminal_status}` — time spent in `running` state before termination.
- `runs_total{terminal_status}` — counter of completed runs by outcome (`stopped`/`failed`/`canceled`).
- `container_start_duration_seconds` — cold-start time for a workspace code container.
- `container_cpu_percent{workspace_id}`, `container_memory_percent{workspace_id}` — sampled every 15s from `docker stats`.
- `active_workspaces` — workspaces with a running container at the last poll.
- `idle_sweep_stops_total` — workspaces stopped by the idle sweep.
- Plus standard Node/process metrics (`process_cpu_seconds_total`, heap, GC, event-loop lag).

**Auth.** `/metrics` requires authentication. If `METRICS_TOKEN` is set, scrapers send `Authorization: Bearer $METRICS_TOKEN`. If unset, the endpoint falls back to admin auth (same as `/admin/*`). Bind the control plane to localhost or a private interface so scrapers reach `/metrics` over a trusted network.

```bash
# Manual probe with bearer token
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics
```

### Shipping metrics to Grafana Cloud (via Alloy)

On the production VM, run [Grafana Alloy](https://grafana.com/docs/alloy/) as a systemd service. Alloy scrapes `localhost:4000/metrics` and remote-writes to Grafana Cloud Prometheus. The control plane has no Grafana Cloud-specific code — swap Alloy for any Prometheus-compatible scraper (vanilla Prometheus, GCP Ops Agent, etc.) without code changes.

Minimum `config.alloy` (replace placeholders with Grafana Cloud stack credentials):

```alloy
prometheus.scrape "control_plane" {
  targets = [{
    __address__ = "127.0.0.1:4000",
    job         = "frc-sim-control",
  }]
  metrics_path = "/metrics"
  scrape_interval = "15s"
  bearer_token = sys.env("METRICS_TOKEN")
  forward_to = [prometheus.remote_write.grafana_cloud.receiver]
}

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = "https://prometheus-prod-XX-prod-us-central-0.grafana.net/api/prom/push"
    basic_auth {
      username = "<grafana-cloud-username>"
      password = sys.env("GRAFANA_CLOUD_API_KEY")
    }
  }
}
```

Load `METRICS_TOKEN` and `GRAFANA_CLOUD_API_KEY` from GCP Secret Manager via systemd `LoadCredential=` and reference them with `EnvironmentFile` or `Environment=`. Suggested starter dashboards:

1. **Control plane:** rate, error rate, p50/p95/p99 latency by `route`, `http_requests_in_flight`, event-loop lag, heap.
2. **Runs:** start rate, `run_build_duration_seconds` quantiles, `run_active_duration_seconds` by `terminal_status`, failure ratio.
3. **Containers:** `container_cpu_percent` and `container_memory_percent` per workspace, `container_start_duration_seconds` histogram, `active_workspaces` over time.

---

## 9. Common Failures and Recovery

### Code container OOM

**Symptoms:** Run reaches "building" then "failed". Docker logs show `Killed` or `oom`.

**Recovery:**
```bash
# Container is auto-recreated on next run. If persistent:
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restart-code
# Or increase memory:
# CODE_MEMORY_LIMIT=3072m (restart control plane)
```

### Editor not loading

**Symptoms:** Editor iframe stays blank or shows connection refused.

**Recovery:**
```bash
# Restart the code container
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restart-code
# Check container logs
docker logs coderunner-workspace-<workspaceId> --tail 50
```

### Gradle build timeout

**Symptoms:** Run shows "failed" after 90 seconds.

**Recovery:** The timeout is normal for cold-cache first builds. Fix:
- Increase `RUN_BUILD_TIMEOUT_MS=180000` (3 minutes)
- Ensure Gradle wrapper cache exists in `data/users/<workspaceId>/home/`
- Second builds are much faster due to Gradle incremental cache

### Host disk full

**Symptoms:** File saves and runs fail with I/O errors.

**Recovery:**
```bash
# 1. Prune run logs (safest, usually largest)
find data/users/*/logs/runs -name "*.log" -delete

# 2. Prune Gradle caches for stopped workspaces
bun run docker:cleanup
for dir in data/users/*/; do rm -rf "$dir/home"; mkdir -p "$dir/home"; done

# 3. Docker cleanup
docker system prune -f
docker builder prune -f
```

Never delete `data/users/*/project/` — that's student work!

### Control plane crash

**Symptoms:** Browser shows disconnected. Containers may still be running.

**Recovery:** Restart the control plane:
```bash
bun run dev:control
```

On startup it:
- Reconnects to existing containers via Docker labels
- Reconciles container state with the database
- Resumes the idle sweep

Student files and containers are preserved across control-plane restarts.

### Student can't log in (slug taken)

**Symptoms:** "That name is taken" error.

**Recovery:** The student should choose a different name, or the operator can check the database:
```bash
bun run migrate:status  # verify DB is accessible
# Then inspect via sqlite3 or the admin API
```

### AS Lite not showing telemetry

**Symptoms:** AdvantageScope Lite iframe shows "disconnected" after run reaches "running".

**Recovery:**
1. Check code container is actually running: `/admin/status`
2. Check alive probe: `curl http://localhost:4000/u/<slug>/sim/alive`
3. If the probe fails, restart the container: admin API → `restart-code`
4. Refresh the browser

### Containers not starting

**Symptoms:** Container status stays at "starting" or shows "error".

**Recovery:**
```bash
# Check Docker is running
docker info

# Check image exists
docker images coderunner-workspace

# Rebuild if missing
bun run docker:build:workspace

# Check for port conflicts
docker ps --format '{{.Ports}}'
```

### Server at capacity (503)

**Symptoms:** Students see a toast "Server at capacity — try again in a moment." when opening their workspace.

**Recovery:**
1. Check the admin Dashboard for current vs. max container count.
2. If legitimate load, bump the cap:
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     -X POST -H "Content-Type: application/json" \
     -d '{"value": 15}' \
     http://localhost:4000/admin/config/max-active-containers
   ```
3. If containers are stale, stop idle ones from the admin panel or wait for idle teardown.
4. Verify host resources via the Grafana dashboards (or local `docker stats`) before raising the cap further.

---

## 10. Host Sizing

### Per-student resource usage

Each active student uses approximately:

| Resource | Code Container | Total |
| --- | --- | --- |
| RAM (steady-state) | ~1.0–1.5 GB | ~1.0–1.5 GB |
| RAM (peak/build) | ~1.5–2.5 GB | ~1.5–2.5 GB |
| CPU (idle) | minimal | minimal |
| CPU (building) | 1–2 cores | 1–2 cores |
| Disk (project) | ~50 MB | ~50 MB |
| Disk (caches) | ~500 MB | ~500 MB |

### Sizing recommendations

| Students | RAM | CPU | Disk | Notes |
| --- | --- | --- | --- | --- |
| 1–3 | 16 GB | 4 cores | 30 GB | Development/testing |
| 4–6 | 16–24 GB | 4–6 cores | 40 GB | Small classroom; lower memory limit if needed |
| 7–10 | 32 GB | 6+ cores | 50 GB | Full classroom; preferred target |
| 10+ | 48+ GB | 8+ cores | 80 GB | Large classroom; raise memory limits |

Reserve ~4 GB for the OS, Docker daemon, and browser overhead.

### Measuring actual usage

Per-container memory and CPU are exported at `/metrics` (Prometheus) and visualised in the Grafana dashboards under `grafana/`. For a quick local snapshot use:

```bash
docker stats --filter label=frc-sim.managed=true --no-stream
```

### Tuning memory limits

If containers are consistently using less than half their limit, you can lower the cap:
```bash
CODE_MEMORY_LIMIT=2048m
```

If containers are hitting their limit (OOM kills), raise it:
```bash
CODE_MEMORY_LIMIT=3072m
```

---

## 11. Project Import

Students can import public GitHub repositories from the topbar menu → **Import from GitHub**.

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/u/{slug}/api/project/import` | Validate an import URL (returns parsed clone URL, branch, subdir) |
| `GET` | `/u/{slug}/api/project/recent-imports` | List recent import backups for the workspace |
| `POST` | `/u/{slug}/api/project/restore` | Restore a project from an import backup (`{ archiveFile: "..." }`) |
| `WS` | `/u/{slug}/ws/import` | WebSocket stream for import progress (send import request as first message) |

### Limits

- **Repository size:** ≤ 100 MB (checked after shallow clone inside the container).
- **Rate limit:** 6 imports per user per hour (in-memory, resets on control-plane restart).
- **Backup retention:** ≤ 5 import backups per workspace; oldest pruned automatically.
- **Clone timeout:** 60 seconds.

### Where import backups live

```
data/users/<workspaceId>/backups/import-<timestamp>.tar.gz   # project archive
data/users/<workspaceId>/backups/import-<timestamp>.json      # import metadata
```

### Manual restore (admin)

If the student UI fails, an operator can restore an import backup using the admin restore endpoint:

```bash
# Find the backup path
ls data/users/<workspaceId>/backups/

# Use the admin backup endpoint or the workspace restore endpoint
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path": "data/backups/..."}' \
  http://localhost:4000/admin/workspaces/<workspaceId>/restore
```

Or the student can use the import dialog's **Restore** button to restore from a recent import backup directly.

---

## 12. Container Concurrency Cap

The system limits how many code containers can run simultaneously, preventing host overload when many students sign in at once.

### How it works

- When a student's container would be the N+1th, the request returns HTTP 503 and the browser shows a toast: "Server at capacity — try again in a moment."
- Already-running containers are unaffected.
- The cap applies to containers with `status=running` plus any in-flight creates.

### Configuration

Set the default cap via environment variable:

```bash
MAX_ACTIVE_CONTAINERS=10   # default
```

### Runtime override (admin)

Admins can raise or lower the cap without restarting the control plane:

```bash
# Read current cap
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/admin/config/max-active-containers

# Set cap to 15
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value": 15}' \
  http://localhost:4000/admin/config/max-active-containers
```

The runtime override is stored in the `runtime_config` database table and takes precedence over the environment variable until changed again.

The admin Dashboard also shows the current cap and active container count, with an inline editor to change it.

---

## 13. Audit Log

All admin actions are recorded in the `audit_log` database table for accountability and debugging.

### What is logged

| Action | Trigger |
| --- | --- |
| `user.promote` | Promoting a user to admin |
| `user.demote` | Demoting an admin to user |
| `user.delete` | Deleting a user and their workspace |
| `container.stop` | Stopping a workspace's containers |
| `container.restart` | Restarting a workspace's code container |
| `template.seed` | Re-seeding a workspace from the template |
| `backup.create` | Creating a project backup |
| `backup.restore` | Restoring a project from backup |
| `allowlist.add` | Adding an email/domain to the allowlist |
| `allowlist.remove` | Removing an email/domain from the allowlist |
| `config.max-active-containers` | Changing the container concurrency cap |

Each entry records: timestamp, actor (user ID + email), action, target (kind + ID), and optional metadata JSON.

### Viewing the audit log

**Admin UI:** Navigate to the "Audit Log" tab in the admin panel. Supports filters by actor, action prefix, and time range, with expandable metadata rows and cursor-based pagination.

**API:**

```bash
# Latest entries
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/admin/audit-log

# Filter by action prefix and limit
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?action=user&limit=50"

# Filter by actor email (substring match)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?actor=coach"

# Paginate (use the smallest id from previous page as cursor)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?before=42&limit=25"
```

### Retention and pruning

Audit entries accumulate indefinitely by default. Prune old entries with the CLI:

```bash
# Remove entries older than 90 days (default)
bun run audit:prune

# Remove entries older than 30 days
bun run audit:prune -- --days 30

# Preview without deleting
bun run audit:prune -- --dry-run
```

**Recommended:** Run `bun run audit:prune` monthly or add it to your maintenance routine.

---

## 14. Cloudflare Pages (optional offline screen)

By default the VM serves everything. Enabling Cloudflare Pages mode moves the React frontend to Cloudflare's CDN so students see a styled "CodeRunner is Offline" screen when the VM is powered off, instead of Chrome's connection-refused error.

The control plane, Docker containers, SQLite database, and all GCE infrastructure remain unchanged. The frontend is deployed to CF Pages on every release; a CF Worker proxies backend paths (`/api/*`, `/u/*`, etc.) to the VM via an `origin.` subdomain that bypasses the CF proxy.

**Full setup instructions**: [`deploy/README.md` → Cloudflare Pages mode](../deploy/README.md).

**Summary of what changes at a glance:**

| What | Change |
| --- | --- |
| DNS | Move zone to Cloudflare nameservers. Add `origin.YOUR_DOMAIN` A record (DNS-only). |
| Caddyfile | Add `origin.YOUR_DOMAIN` vhost (automatic on new VMs; one-liner on existing ones). |
| Wrangler | Replace `YOUR_DOMAIN` placeholders in `deploy/cloudflare/wrangler.toml`. |
| GitHub Actions | Add `CF_ACCOUNT_ID` (var) and `CF_API_TOKEN` (secret) to the repo. |
| Releases | No change — same `gh workflow run "Deploy to GCE"` command deploys both. |

**To disable**: remove `CF_ACCOUNT_ID` from GitHub repo variables. The `deploy-cloudflare` job is skipped and the VM serves everything as before.

---

## Quick Reference Card

| Task | Command |
| --- | --- |
| **Start the app (prod)** | `bun run start` |
| **Start the app (dev)** | `bun run dev:control` |
| **Stop the app** | Ctrl+C |
| **Prod build (web + ascope + GHCR pull)** | `bun run build` |
| **Build workspace image (local)** | `bun run docker:build:workspace` |
| **Pull workspace image (GHCR)** | `bun run docker:pull:workspace` |
| **Build web shell** | `bun run build:web` |
| **Build AS Lite** | `bun run build:ascope` |
| **Clean build artifacts** | `bun run clean` |
| **Run migrations** | `bun run migrate` |
| **Check migration status** | `bun run migrate:status` |
| **Typecheck** | `bun run typecheck` |
| **Lint + format + organize imports (write)** | `bun run check:fix` |
| **Lint + format check only** | `bun run check` |
| **CI gate (biome + typecheck + tests)** | `bun run verify` |
| **Test suite** | `bun run test` |
| **Resource monitoring** | Grafana dashboards under `grafana/` (or `docker stats`) |
| **Backup projects** | `bun run backup` |
| **Restore projects** | `bun run restore -- <dir>` |
| **Cleanup containers** | `bun run docker:cleanup` |
| **Prune audit log** | `bun run audit:prune` |
| **Admin status** | `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/admin/status` |
| **Restart code container** | `curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST http://localhost:4000/admin/workspaces/<id>/restart-code` |
| **Stop workspace containers** | `curl -H "Authorization: Bearer $ADMIN_TOKEN" -X POST http://localhost:4000/admin/workspaces/<id>/stop-containers` |
