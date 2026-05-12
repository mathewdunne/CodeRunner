# CodeRunner V2 — Manual Acceptance Tests

Use this checklist after the automated V2 checks pass. The goal is to verify the real classroom path: each student gets their own openvscode-server editor, project files persist, Run starts only that student's sim, and AdvantageScope Lite connects to that student's NT4 stream.

## Prerequisites

Run these from the repo root:

```bash
bun install
bun run docker:build:code
bun run build:ascope
bun run build:web
bun run migrate:status
bun run typecheck
bun run test
```

Use the manual checklist below after the automated suite is green. Run `bun run measure` with representative users if host capacity is uncertain.

## Start The Server

Find the host LAN IP:

```bash
ip addr show | grep 'inet ' | grep -v 127.0.0.1
```

Start the control plane:

```bash
bun run dev:control
```

Expected startup output includes:

```text
─── V2 Configuration ───
  Code image:          frc-code:v2
  VSCode ports:        33000-33099
V2 control plane listening on http://localhost:4000
```

Open `http://<host-ip>:4000` from 2-3 browsers, browser profiles, or LAN machines. Use distinct names such as `alice`, `bob`, and `charlie`.

## Manual Tests

### 1. Login And Isolation

1. Log in as `alice` on one browser and `bob` on another.
2. Confirm each browser redirects to `/u/<name>/`.
3. In a terminal, get `alice` and `bob` workspace IDs from:

```bash
curl http://localhost:4000/admin/status
```

Success criteria:

- Each browser shows the V2 shell with Run, Stop, console, openvscode editor, and AdvantageScope Lite.
- `docker ps --filter label=frc-sim.role=code` shows one `frc-v2-code-<workspaceId>` container per active user.
- No browser can open another user's `/u/<slug>/` or `/u/<slug>/vscode/` route.

### 2. Editor And Project Persistence

1. In `alice`'s editor, open `src/main/java/frc/robot/Robot.java`.
2. Add a harmless comment and wait for VS Code auto-save.
3. Refresh the browser.
4. Reopen the file.
5. Stop `alice`'s container:

```bash
curl -X POST http://localhost:4000/admin/workspaces/<alice-workspace-id>/stop-containers
```

6. Refresh `alice`'s browser again.

Success criteria:

- The WPILib project tree is present.
- The edit survives browser refresh and container restart.
- The editor reconnects through `/u/alice/vscode/`.

### 3. File Operations

1. In `alice`'s VS Code explorer, create `src/main/java/frc/robot/subsystems/Arm.java`.
2. Add:

```java
package frc.robot.subsystems;

public class Arm {}
```

3. Rename it to `Elevator.java`, update the class name, then delete it.
4. Check `bob`'s file tree throughout.

Success criteria:

- Create, rename, and delete update immediately in `alice`'s editor.
- `bob` never sees `alice`'s file.

### 4. Java IDE Features

1. Wait for the Java extension to finish initializing in `alice`'s editor.
2. Hover over `TimedRobot`.
3. Type `this.` inside a method and check completions.
4. Introduce a syntax error, then fix it.
5. Optional after editor or extension version bumps: verify auto-import on Tab for `Pose2d` and Ctrl-click/F12 into WPILib source. Decision 011 is the accepted evidence when versions have not changed.

Success criteria:

- Hover, completion, and diagnostics work in the editor.
- Diagnostics stay scoped to the user who edited the file.

### 5. Run And Stop

1. Click Run as `alice`.
2. Immediately click Run as `bob`.
3. Click Stop for one user after their sim reaches `running`.

Success criteria:

- Console status progresses through `building` and `running`.
- Gradle and sim logs stream only to the matching user's console.
- Stop affects only that user's sim.

### 6. AdvantageScope Lite

1. With `alice` running, watch the AdvantageScope Lite pane.
2. Start `bob`'s sim too.
3. Stop only `alice`.

Success criteria:

- AdvantageScope connects without manual endpoint entry.
- NT4 topics appear for the running sim.
- Stopping one user does not disconnect the other user's telemetry.

### 7. Admin Backup And Restore

Create a backup:

```bash
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/backup
```

Restore from the returned archive path:

```bash
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restore \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/data/backups/<timestamp>/<workspaceId>/project.tar.gz"}'
```

Success criteria:

- Backup creates `data/backups/<timestamp>/<workspaceId>/project.tar.gz`.
- Restore accepts only archives under `data/backups/`.
- Restored files appear in the editor after refresh.

### 8. Idle Teardown

For a fast test, restart with:

```bash
IDLE_STOP_MINUTES=2 bun run dev:control
```

1. Log in as `alice`, run once, then close the browser tab.
2. Wait more than two minutes.
3. Check Docker:

```bash
docker ps --filter label=frc-sim.workspace=<alice-workspace-id>
```

4. Reopen `alice`'s workspace.

Success criteria:

- The code container stops after the idle timeout.
- `data/users/<workspaceId>/project/` remains intact.
- Returning to the workspace recreates the container automatically.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| LAN browser cannot connect | Open firewall port 4000 and verify `curl http://<host-ip>:4000` from another machine. |
| Shell says web build missing | Run `bun run build:web`. |
| AdvantageScope is blank | Run `bun run build:ascope` and verify `dist/advantagescope/index.html` exists. |
| Editor iframe fails | Verify `frc-code:v2` exists and inspect `docker logs frc-v2-code-<workspaceId>`. |
| Java never becomes ready | Wait for first Gradle import; then check container memory and logs. |
| Run stays building | Check Docker health, active containers, Gradle logs, and `RUN_BUILD_TIMEOUT_MS`. |
| Permission errors | Build/run with matching `FRC_UID=$(id -u)` and `FRC_GID=$(id -g)`. |
