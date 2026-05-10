# FRC Web Simulator V2 — Operator Runbook

This runbook covers deploying and operating the FRC Web Simulator V2 on a classroom machine. For architecture details, see [`V2-Design.md`](../V2-Design.md).

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
git clone <repo-url> FRC-Programming-Training-Sim
cd FRC-Programming-Training-Sim
git submodule update --init --recursive
bun install
```

### 2.2 Build the code container image

```bash
bun run docker:build:code
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

**At minimum**, change the session secret:

```bash
# .env
FRC_SESSION_SECRET=your-random-secret-string-here
```

See [Configuration](#5-configuration) for all options.

### 2.5 Run migrations

```bash
bun run migrate
```

### 2.6 Verify the setup

```bash
bun run typecheck
bun run test
```

The integration test suite covers session isolation, multi-workspace routing, run log streaming, editor proxying, NT4 proxying, lifecycle reconciliation, and admin operations.

### 2.7 Measure host resources

```bash
bun run measure
```

This reports host RAM, CPU, disk, and (if containers are running) actual memory usage per container with extrapolation for 10 students.

---

## 3. Starting the App

### One-command start

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
curl http://localhost:4000/admin/status
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
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/stop-containers
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
| `FRC_SESSION_SECRET` | *(dev default)* | **Change this!** HMAC secret for session cookies |
| `FRC_DOCKER_PATH` | `docker` | Docker binary path |
| `FRC_CONTAINER_USER` | auto-detected | UID:GID used inside code containers |
| `FRC_UID` / `FRC_GID` | *(none)* | Alternative UID/GID inputs when `FRC_CONTAINER_USER` is unset |
| `FRC_CONTAINER_AUTO_START` | `true` | Start the code container when a workspace opens |
| `CODE_IMAGE` | `frc-code:v2` | Docker image for merged code containers |
| `CODE_MEMORY_LIMIT` | `2560m` | Memory cap per code container |
| `SIM_PORT_RANGE` | `25810-25899` | Loopback port range for sim NT4 |
| `VSCODE_PORT_RANGE` | `33000-33099` | Loopback port range for openvscode-server |
| `RUN_BUILD_TIMEOUT_MS` | `90000` | Build timeout before a run fails |
| `SIM_STARTUP_TIMEOUT_MS` | `30000` | Sim readiness timeout after build startup |
| `IDLE_STOP_MINUTES` | `30` | Stop containers after N min idle |
| `IDLE_CHECK_INTERVAL_MS` | `60000` | Idle sweep interval |
| `ADMIN_TOKEN` | *(none)* | Bearer token for admin API; unset = localhost-only |

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
| `data/users/*/project/` | Student Java source code | **Yes** |
| `data/users/*/home/` | Gradle cache, tool state, vscode user data | No (regenerated on container start) |
| `data/users/*/logs/` | Build/run log history | No (transient, safe to prune) |
| `data/app.db` | User/workspace/session metadata | Optional (can be recreated) |

### Create a backup

```bash
bun run backup
```

This creates a timestamped snapshot under `data/backups/YYYY-MM-DD-HHmmss/` containing only `project/` directories.

To specify a custom output:

```bash
bun run backup -- --output /path/to/backup
```

### Restore from backup

**Stop the control plane first**, then:

```bash
bun run restore -- <backup-dir>
```

To preview without writing:

```bash
bun run restore -- <backup-dir> --dry-run
```

To restore a single workspace:

```bash
bun run restore -- <backup-dir> --workspace ws_abc123...
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
curl http://localhost:4000/admin/status | jq .
```

Returns:
- All workspaces with code container state
- Idle flags per workspace
- Active build count
- Configured limits

### Resource measurement

```bash
bun run measure
```

Shows host RAM/CPU, per-container memory usage, and 10-student extrapolation.

For JSON output (useful for scripting/dashboards):

```bash
bun run measure -- --json
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

---

## 9. Common Failures and Recovery

### Code container OOM

**Symptoms:** Run reaches "building" then "failed". Docker logs show `Killed` or `oom`.

**Recovery:**
```bash
# Container is auto-recreated on next run. If persistent:
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restart-code
# Or increase memory:
# CODE_MEMORY_LIMIT=3072m (restart control plane)
```

### Editor not loading

**Symptoms:** Editor iframe stays blank or shows connection refused.

**Recovery:**
```bash
# Restart the code container
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restart-code
# Check container logs
docker logs frc-v2-code-<workspaceId> --tail 50
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
docker images frc-code:v2

# Rebuild if missing
bun run docker:build:code

# Check for port conflicts
docker ps --format '{{.Ports}}'
```

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

Run the measurement tool with active students to get real numbers:

```bash
bun run measure
```

Example output:
```
═══ FRC Web Simulator — Resource Report ═══

Host:
  Hostname:    classroom-pc
  Platform:    linux x64
  CPU:         Intel Core i7-12700 (20 cores)
  RAM:         12.3 GB used / 32.0 GB total (19.7 GB free)

V2 Containers:
  Name                                Role  Mem Used   Mem Limit  Mem%    CPU%
  frc-v2-code-ws_abc123...            code  1280.5 MB  2560.0 MB  50.0%   0.1%
  ...

  Total: 3 code containers, 3841 MB memory

Extrapolation for 10 Students:
  Avg code memory:  1280 MB × 10 = 12.5 GB
  Estimated total:  12.5 GB (+ ~4 GB OS/Docker/browser overhead)
  Host headroom:    15.5 GB

  → Host has ample capacity for 10 students (15.5 GB headroom).
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

## Quick Reference Card

| Task | Command |
| --- | --- |
| **Start the app** | `bun run dev:control` |
| **Stop the app** | Ctrl+C |
| **Build code image** | `bun run docker:build:code` |
| **Build web shell** | `bun run build:web` |
| **Build AS Lite** | `bun run build:ascope` |
| **Run migrations** | `bun run migrate` |
| **Check migration status** | `bun run migrate:status` |
| **Typecheck** | `bun run typecheck` |
| **Test suite** | `bun run test` |
| **Measure resources** | `bun run measure` |
| **Backup projects** | `bun run backup` |
| **Restore projects** | `bun run restore -- <dir>` |
| **Cleanup containers** | `bun run docker:cleanup` |
| **Admin status** | `curl http://localhost:4000/admin/status` |
| **Restart code container** | `curl -X POST http://localhost:4000/admin/workspaces/<id>/restart-code` |
| **Stop workspace containers** | `curl -X POST http://localhost:4000/admin/workspaces/<id>/stop-containers` |
