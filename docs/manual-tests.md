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

### 9. Gamepad / Keyboard Driver Controls

Use a WPILib template that reads from `CommandXboxController(0)` so you can verify input reaches the robot code. Controller checks require a USB or Bluetooth gamepad (Xbox / PS4 / DualSense / generic DInput-standard).

1. Plug in a controller. In Chrome / Edge, gamepads only appear after the page receives a user input event on the pad — press any button.
2. Open the workspace and click the **Controls** icon in the Driver Station rail. Confirm Controller mode is selected by default.
3. Confirm the controller appears in the dropdown. The "Joysticks" status tile in the Workbench shows amber ("warn") until the controller is selected.
4. Select the controller. Move the sticks and press buttons — the SVG visualization must reflect state in real time (sticks displace, ABXY light their color, bumpers/triggers fill, D-pad arms light emerald).
5. Switch to the **Console** rail tab. Confirm the visualization is not visible but `navigator.getGamepads()` is still polling (you can verify with `print` in `teleopPeriodic` once running).
6. Click **Run** and wait for `simRunStatus === "running"`. The Workbench joystick tile flips to green ("connected").
7. Switch DS to Teleop and click Enable.
8. Drive the robot in AdvantageScope. Sticks and triggers must read the same values the SVG shows.
9. With the robot still enabled, yank the USB cable (or power off the wireless controller). Within one frame:
   - The Controls panel dropdown clears the selection and reverts to "Plug in a controller and press any button."
   - The "Joysticks" status tile returns to amber.
   - The DS reports `enabled: false` (safety release).
10. Reconnect the controller, re-select it, re-enable. Resume driving.
11. Select Keyboard mode. Confirm the selected source is `Keyboard (Standard Xbox)` and the mapping dialog opens from **View mapping**.
12. Focus the Keyboard tile. Press `W/A/S/D`, `Q/O`, `K/L/J/I`, and `Z/X/C/V`; the SVG visualization must update with left stick, triggers, buttons, and POV state.
13. With Teleop enabled, drive from the focused Keyboard tile. Click outside the tile while holding a mapped key; input must return neutral immediately and the robot must stop receiving that key.
14. Switch back to Controller mode, re-select the physical controller if needed, and confirm existing gamepad behavior still works.
15. Close the browser tab while enabled. Open a second tab and load `/api/sim/status`; confirm `driverStation.enabled` is `false` (server-side safety on WS close).

Success criteria:

- Visualization updates at 60 Hz with no perceptible lag.
- Selection and release send `select` / `release` over `/u/{slug}/ws/gamepad`; check the control plane logs are clean (no schema validation errors).
- Keyboard mode reuses `/u/{slug}/ws/gamepad`, drives only while the Keyboard tile has focus, and clears to neutral on blur.
- Hot-unplug always disables the robot.
- Robot code observes the standard WPILib XboxController axis/button mapping (axes 0/1 = LeftX/Y, 2/3 = LT/RT, 4/5 = RightX/Y; buttons 1..10 = A,B,X,Y,LB,RB,Back,Start,LS,RS; POV 0 = D-pad).

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
