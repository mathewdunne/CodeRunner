# V2 Code Container (`frc-code:v2`)

Merged per-student container for V2. Combines the V1 sim and LSP containers into a single image running openvscode-server with baked-in Java IDE support.

## What's Inside

| Component | Version | Purpose |
|---|---|---|
| openvscode-server | 1.105.1 | Browser-based VS Code editor |
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

Or with custom UID/GID:

```bash
FRC_UID=$(id -u) FRC_GID=$(id -g) bun run docker:build:code
```

Tags the image as `frc-code:v2` by default. Override with `CODE_IMAGE` env var.

## Runtime Contract

### Bind mounts

| Host path | Container path | Purpose |
|---|---|---|
| `data/users/<workspaceId>/project` | `/workspace/project` | Student code (authoritative) |
| `data/users/<workspaceId>/home` | `/home/frc` | Gradle cache, editor state, extensions |

### Published ports

| Container port | Purpose |
|---|---|
| 3000 | openvscode-server (HTTP + WebSocket) |
| 5810 | NT4 (NetworkTables, for AdvantageScope) |

Both must be published on `127.0.0.1` only (loopback). The control plane proxy is the sole browser-facing endpoint.

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
| `VSCODE_BASE_PATH` | Yes behind proxy | Reverse proxy base path, e.g. `/u/<slug>/vscode/`. Omit or set `/` for direct hand-launched smoke tests. |

### Example run

```bash
docker run -d \
  --name frc-v2-code-<workspaceId> \
  --label frc-sim.managed=true \
  --label frc-sim.version=v2 \
  --label frc-sim.role=code \
  --label frc-sim.workspace=<workspaceId> \
  -v "$PWD/data/users/<workspaceId>/project:/workspace/project" \
  -v "$PWD/data/users/<workspaceId>/home:/home/frc" \
  -p 127.0.0.1:<vscodePort>:3000 \
  -p 127.0.0.1:<simPort>:5810 \
  --user $(id -u):$(id -g) \
  --memory=2560m \
  -e VSCODE_BASE_PATH=/u/<slug>/vscode/ \
  frc-code:v2
```

## First-Run Behavior

On first start with an empty `/home/frc`, the entrypoint:

1. Copies the primed Gradle cache from `/opt/frc-gradle-cache/` into `$GRADLE_USER_HOME`.
2. Copies pre-installed VS Code extensions from `/opt/frc-extensions-cache/` into `$HOME/.openvscode-server/extensions/`.

Subsequent starts skip these copies (directories already populated from the bind mount).

## Sim Scripts

- `/usr/local/bin/start-sim.sh` — Starts `./gradlew simulateJava` in the background. Used by the run queue via `docker exec`.
- `/usr/local/bin/stop-sim.sh` — Stops the sim process tree gracefully (SIGTERM, then SIGKILL after 10s).

These are identical to the V1 sim scripts and depend on the same PID-file and process-group conventions.

## Image Size

Built image size: ~4.8 GiB (uncompressed). Includes JDK (~300 MB), openvscode-server runtime, 9 VS Code extensions (~200 MB), and the primed Gradle/WPILib dependency cache (~1 GB).
