# V2 Code Container (`coderunner-workspace`)

Merged per-student container for V2. Combines openvscode-server + Java IDE + WPILib support in a single image using the linuxserver.io base (Ubuntu 24.04, s6-overlay).

## What's Inside

| Component | Version | Purpose |
|---|---|---|
| Base image | linuxserver/openvscode-server:1.109.5 | Ubuntu 24.04, s6-overlay, openvscode-server, PUID/PGID |
| openvscode-server | 1.109.5 (from base) | Browser-based VS Code editor |
| JDK | Temurin 17.0.15+6 | Java compilation and simulation |
| redhat.java | 1.38.0 | Java language support (JDT LS) |
| vscode-wpilib | 2026.1.1 | WPILib project tooling |
| Java Extension Pack | 0.30.5 | Debugger, test runner, Maven/Gradle, project manager |
| Spotless Gradle | 1.2.1 | Code formatting via Spotless |
| Gradle cache | Primed from template | Fast first builds (~seconds vs ~minutes) |

## Build

```bash
bun run docker:build:code
```

Tags the image as `coderunner-workspace` by default. Override with `CODE_IMAGE` env var.

## Runtime Contract

### Bind mounts

| Host path | Container path | Purpose |
|---|---|---|
| `data/users/<workspaceId>/project` | `/workspace/project` | Student code (authoritative) |
| `data/users/<workspaceId>/home` | `/config` | Gradle cache, editor state, extensions |

### Published ports

| Container port | Purpose |
|---|---|
| 3000 | openvscode-server (HTTP + WebSocket) |
| 3300 | HALSim WebSocket server |
| 5810 | NT4 (NetworkTables, for AdvantageScope) |

All must be published on `127.0.0.1` only (loopback). The control plane proxy is the sole browser-facing endpoint.

### Labels

```
frc-sim.managed=true
frc-sim.version=v2
frc-sim.role=code
frc-sim.workspace=<workspaceId>
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PUID` | Yes | User ID for file permissions (matches host UID) |
| `PGID` | Yes | Group ID for file permissions (matches host GID) |
| `VSCODE_BASE_PATH` | Yes behind proxy | Reverse proxy base path, e.g. `/u/<slug>/vscode/` |

### Example run

```bash
docker run -d \
  --name coderunner-workspace-<workspaceId> \
  --label frc-sim.managed=true \
  --label frc-sim.version=v2 \
  --label frc-sim.role=code \
  --label frc-sim.workspace=<workspaceId> \
  -v "$PWD/data/users/<workspaceId>/project:/workspace/project" \
  -v "$PWD/data/users/<workspaceId>/home:/config" \
  -p 127.0.0.1:<vscodePort>:3000 \
  -p 127.0.0.1:<simPort>:5810 \
  -p 127.0.0.1:<halsimPort>:3300 \
  -e PUID=$(id -u) \
  -e PGID=$(id -g) \
  -e VSCODE_BASE_PATH=/u/<slug>/vscode/ \
  --memory=2560m \
  coderunner-workspace
```

## s6-overlay Services

The container uses s6-overlay for process supervision. The upstream `linuxserver/openvscode-server` image provides the base services; we add FRC-specific layers:

- **`init-openvscode-server`** (upstream): Creates `/config` dirs, fixes permissions, configures sudo.
- **`init-frc-setup`** (ours, oneshot): Seeds Gradle cache and extensions on first run, validates project mount, fixes permissions.
- **`svc-openvscode-server`** (upstream, run script overridden): Launches openvscode-server as `abc` user with health check, custom extensions/data dirs, and server-base-path.

## First-Run Behavior

On first start with an empty `/config`, the init script:

1. Copies the primed Gradle cache from `/opt/frc-gradle-cache/` into `/config/.gradle/`.
2. Copies pre-installed VS Code extensions from `/opt/frc-extensions-cache/` into `/config/extensions/`.

Subsequent starts skip these copies (directories already populated from the bind mount).

## Sim Scripts

- `/usr/local/bin/start-sim.sh` — Starts `./gradlew simulateJava` in the background. Used by the run queue via `docker exec`.
- `/usr/local/bin/stop-sim.sh` — Stops the sim process tree gracefully (SIGTERM, then SIGKILL after 10s).

## Image Size

Built image size: ~4.5 GiB (uncompressed). Includes JDK (~300 MB), openvscode-server runtime, 9 VS Code extensions (~200 MB), and the primed Gradle/WPILib dependency cache (~1 GB).
