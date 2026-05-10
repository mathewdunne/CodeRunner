# FRC Web Simulator V2 — Manual Acceptance Tests

These tests verify the V2 Definition of Done using real browser sessions from multiple machines on a LAN. Run them after the automated `bun run verify:v2:three-user` smoke passes.

---

## Prerequisites

Before running manual tests, ensure:

1. Code container image is built: `bun run docker:build:code`
2. Web shell is built: `bun run build:web`
3. AdvantageScope Lite is built: `bun run build:ascope`
4. Dependencies installed: `bun install`
5. Typecheck passes: `bun run typecheck`
6. Automated smoke passes: `bun run verify:v2:three-user`

---

## Starting the Server for LAN Access

The control plane listens on all interfaces by default (port 4000). Students on the same network can connect via your machine's LAN IP.

### 1. Find your host IP

```bash
# Linux
ip addr show | grep 'inet ' | grep -v 127.0.0.1

# Windows (PowerShell)
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' }
```

Note the IP address (e.g. `192.168.1.50`).

### 2. Start the control plane

```bash
cd /path/to/FRC-Programming-Training-Sim
bun run dev:control
```

You should see:

```
─── V2 Configuration ───
  Data dir:            data
  Code image:          frc-code:v2  (memory: 2560m)
  ...
────────────────────────
V2 control plane listening on http://localhost:4000
```

### 3. Connect from other machines

On each LAN computer, open a browser and navigate to:

```
http://<host-ip>:4000
```

For example: `http://192.168.1.50:4000`

### 4. Firewall (if needed)

If connections are refused, open port 4000:

```bash
# Linux (ufw)
sudo ufw allow 4000/tcp

# Linux (firewalld)
sudo firewall-cmd --add-port=4000/tcp --permanent && sudo firewall-cmd --reload

# Windows (PowerShell, run as admin)
New-NetFirewallRule -DisplayName "FRC Sim V2" -Direction Inbound -Port 4000 -Protocol TCP -Action Allow
```

---

## Test Plan

Use 2–3 computers (or browser profiles) on the LAN. Assign each a distinct username.

Suggested names: `alice`, `bob`, `carol`

---

### Test 1: Concurrent Login and Workspace Isolation

**Steps:**

1. On Machine A, navigate to `http://<host-ip>:4000`
2. Enter username `alice` and submit
3. On Machine B, navigate to the same URL
4. Enter username `bob` and submit
5. (Optional) On Machine C, log in as `carol`

**Success criteria:**

- Each user is redirected to `/u/<username>/` (e.g. `/u/alice/`)
- Each user sees the V2 IDE shell with the openvscode editor, run panel, and AdvantageScope iframe
- The username/workspace indicator shows the correct name
- No errors in the browser console related to session/auth

---

### Test 2: Persistent Multi-File Project

**Steps:**

1. As `alice`, the openvscode editor should show the file tree with the WPILib project
2. Verify the default WPILib project structure is present:
   - `src/main/java/frc/robot/Robot.java`
   - `src/main/java/frc/robot/RobotContainer.java`
   - `src/main/java/frc/robot/Constants.java`
   - `src/main/java/frc/robot/Main.java`
   - `build.gradle`
3. Click on `Robot.java` to open it in the editor
4. Make a small edit (e.g. add a comment `// Alice was here`)
5. Wait for auto-save (VS Code auto-saves by default)
6. Refresh the page
7. Re-open `Robot.java`

**Success criteria:**

- The file tree loads the full WPILib command-based template
- The edit is preserved after page refresh
- The editor reconnects and reopens the last buffer

---

### Test 3: File Operations — Create, Rename, Delete

**Steps:**

1. As `alice`, right-click in the VS Code file explorer
2. Create a new file: `subsystems/DriveSubsystem.java` under `src/main/java/frc/robot/`
3. Add some content: `package frc.robot.subsystems;`
4. Rename the file to `subsystems/TankDrive.java`
5. Delete the file
6. Verify the tree updates at each step

**Success criteria:**

- File appears in the tree immediately after creation
- Rename updates the tree and tab title without losing content
- Delete removes the file from the tree
- These operations do NOT appear in `bob`'s file tree

---

### Test 4: File Isolation Between Users

**Steps:**

1. As `alice`, create a file `src/main/java/frc/robot/AliceOnly.java` with content `// alice`
2. As `bob`, check the file tree

**Success criteria:**

- `bob` does NOT see `AliceOnly.java` in their project
- `bob`'s project tree shows only their own files
- Attempting to access `alice`'s files via URL manipulation returns 403

---

### Test 5: Build and Run with Log Streaming

**Steps:**

1. As `alice`, click the **Run** button
2. Observe the console/log panel at the bottom

**Success criteria:**

- Status progresses: `queued` → `building` → `running`
- Gradle build output streams in real time (you see `BUILD SUCCESSFUL` or compilation output)
- After build, sim startup logs appear
- Status reaches `running` when NT4 is ready (usually 5–15 seconds after build)
- Build logs appear only in `alice`'s console, not in `bob`'s

---

### Test 6: Run Queue Under Contention

**Steps:**

1. Set `RUN_CONCURRENCY=1` in `.env` and restart the control plane (or use the default of 2)
2. As `alice`, click Run
3. Immediately, as `bob`, click Run
4. Observe both consoles

**Success criteria:**

- If concurrency is 1: one user shows `queued` with position while the other builds
- Queue position updates as the first build finishes
- Both users eventually reach `running`
- Neither build fails due to contention

---

### Test 7: AdvantageScope Lite Telemetry

**Steps:**

1. As `alice`, run the sim until status is `running`
2. Observe the AdvantageScope Lite panel on the right

**Success criteria:**

- The AS Lite iframe shows telemetry data (timestamps, NT4 topics appear in the scope view)
- The scope connects without manual intervention (postMessage endpoint injection works)
- If `bob` also has a running sim, `bob`'s scope shows different data than `alice`'s
- No cross-talk: stopping `alice`'s sim does not affect `bob`'s scope

---

### Test 8: Java IDE — Hover, Completion, Diagnostics

Java IDE features are provided by the redhat.java extension running inside the code container. Do not re-test auto-import or F12/Ctrl-click into WPILib classes unless extension versions changed since Decision 011.

**Steps:**

1. As `alice`, open `Robot.java` in the VS Code editor
2. Wait for "Java is ready" in the VS Code status bar
3. Hover over a class name (e.g. `TimedRobot`) — a tooltip should appear
4. Type `this.` inside a method — completion suggestions should appear
5. Introduce a syntax error (e.g. delete a semicolon) — a red squiggly should appear
6. Fix the error — the diagnostic should clear

**Steps (isolation check):**

7. As `bob`, open their `Robot.java`
8. Introduce an error in `bob`'s file
9. Verify `alice`'s editor remains clean (no false diagnostics)

**Success criteria:**

- Hover shows type information within a few seconds of "Java is ready"
- Completions appear for Java standard library and WPILib classes
- Diagnostics (red squigglies) appear within a few seconds of introducing an error
- Fixing the error clears diagnostics
- `bob`'s errors do not bleed into `alice`'s editor

---

### Test 9: Cross-File Java Features

**Steps:**

1. As `alice`, create `src/main/java/frc/robot/subsystems/Arm.java` in the VS Code file explorer
2. Add a class definition: `package frc.robot.subsystems; public class Arm {}`
3. Open `RobotContainer.java`
4. Type `new Arm` — completion/import suggestion should appear

**Success criteria:**

- The Java extension is aware of newly created files without restarting
- Cross-file references resolve (imports, class references)
- This confirms project-wide Java features via the bundled redhat.java extension

---

### Test 10: Idle Teardown and Return

**Steps:**

1. As `alice`, verify sim is running (status shows `running`)
2. Close `alice`'s browser tab completely
3. Wait for the idle timeout (default: 30 minutes; for testing, you can set `IDLE_STOP_MINUTES=2` in `.env`)
4. On the host, check Docker: `docker ps --filter label=frc-sim.workspace`
5. After the timeout, verify `alice`'s container has stopped
6. Re-open `alice`'s browser to `http://<host-ip>:4000`
7. Log in as `alice` again

**Success criteria:**

- After the idle timeout, `docker ps` no longer shows `alice`'s code container
- `alice`'s project files still exist on disk (`data/users/*/project/`)
- Upon returning, `alice` sees their workspace with all files intact
- Containers are re-created automatically when the workspace loads
- No data loss

---

### Test 11: Operator Controls

**Steps:**

1. From the host machine (or using the admin token), call the admin API:

```bash
# Check overall status
curl http://localhost:4000/admin/status

# Restart alice's code container (replace <workspaceId> with alice's workspace ID from status)
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/restart-code

# Stop alice's containers
curl -X POST http://localhost:4000/admin/workspaces/<workspaceId>/stop-containers
```

2. After restarting the code container, check that `alice`'s editor reconnects and Java features resume
3. Verify `alice` can Run again

**Success criteria:**

- `/admin/status` returns JSON listing all workspaces and container states
- Restarting one user's container does not affect other users
- `alice`'s files are untouched after restart
- Editor reconnects within ~10 seconds after restart

---

### Test 12: Full Classroom Session (End-to-End)

**Steps:**

1. Start fresh: `bun run docker:cleanup` then restart the control plane
2. Have all users (2–3 machines) log in
3. Each user: open a file, make edits, run the sim, observe telemetry
4. Let the session run for 10+ minutes with intermittent edits and re-runs
5. One user stops their sim manually (click Stop)
6. One user refreshes their page mid-run

**Success criteria:**

- No operator intervention needed during the session
- All users can edit → run → see telemetry independently
- Stopping one user's sim does not affect others
- Page refresh reconnects to the existing session seamlessly
- No memory errors, OOM kills, or unhandled crashes in the control-plane terminal
- Host resources remain stable (check with `bun run measure` or `htop`)

---

## Quick Reference: Environment Overrides for Testing

Set these in `.env` (or export before `bun run dev:control`) to speed up testing:

| Variable | Testing value | Purpose |
| --- | --- | --- |
| `IDLE_STOP_MINUTES` | `2` | Faster idle teardown for Test 10 |
| `RUN_CONCURRENCY` | `1` | Force queue behavior for Test 6 |
| `ADMIN_TOKEN` | `test-token` | Allow remote admin access with `Authorization: Bearer test-token` |
| `PORT` | `4000` | Default; change if port is in use |

---

## Troubleshooting During Tests

| Symptom | Check |
| --- | --- |
| Can't connect from LAN | Firewall blocking port 4000; verify with `curl http://<host-ip>:4000` from host itself |
| Login page doesn't load | `bun run build:web` may not have been run; check that `apps/web/dist/` exists |
| AS Lite shows blank | `bun run build:ascope` may not have been run; check that `dist/advantagescope/` exists |
| Run stays in `queued` | Check Docker is running; check `docker ps` for existing builds |
| Editor iframe blank | Check container is running; check `docker logs frc-v2-code-<workspaceId>` |
| Java not ready | Wait 1–3 minutes for redhat.java to initialize; check container logs |
| Container start fails | Check `docker images frc-code:v2`; rebuild if missing with `bun run docker:build:code` |
| Permission errors on Linux | Set `FRC_UID` and `FRC_GID` in `.env` to match your user's UID/GID |
