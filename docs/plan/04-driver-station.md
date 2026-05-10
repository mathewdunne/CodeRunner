# Plan 04 — Driver Station UI (functional)

## Context

The bottom pane today is two thin affordances: Run / Stop buttons and a
read-only `<pre>` console. Replace them with a SystemCore-style **functional**
driver station:

- **Enable / Disable** that actually toggles `DriverStation.isEnabled()` in
  the running WPILib robot code.
- **Auto / Teleop / Test** mode selector that actually flips
  `autonomousPeriodic()` vs `teleopPeriodic()` execution.
- **Sim Start / Stop / Restart** wired to the existing `/run` endpoints.
- A console panel that is more readable than today's `<pre>`.
- Status readout (Robot Code, Comms, Joysticks) — the SystemCore look.

This is the headline feature of the post-V2 work. It also sets up future
work: controller settings, match timer, tournament mode.

## Background — how WPILib accepts external DS control

WPILib provides a HALSim WebSocket server extension (`halsim_ws_server`)
that exposes a JSON-over-WebSocket protocol. External tools can publish
messages on this socket to drive the simulated `DriverStation`. Fields
include:

- `enabled` (bool)
- `autonomous` (bool)
- `test` (bool)
- `eStop` (bool)
- `fmsAttached` (bool, leave false)
- `dsAttached` (bool)
- `allianceStationId` (enum)
- Joystick axes / buttons / POVs

This is the same protocol used by AdvantageScope's "Control Sim" panel and by
the Romi/XRP toolchains. It's the WPILib-blessed path; NT4 control words are
not standardized.

The protocol uses messages of the form:
```json
{ "type": "DriverStation", "device": "", "data": { ">enabled": true } }
```
Read-write fields are prefixed `<>` (e.g., `<>enabled` from sim, `>enabled`
from external). The `halsim_ws_server` extension is loaded via Gradle config
in the WPILib project (e.g., `wpi.sim.addWebsocketsServer().defaultEnabled =
true`).

When authoring this plan, **start with a short HALSim WebSocket proof**. The
repo currently has no HALSim WS path, and the exact Gradle API, env var, WS
path, and message/readback behavior should be proven against the pinned WPILib
version before building the UI around it.

## Out of scope

- Controller / gamepad input — `JoystickPanel.tsx` is a placeholder
  ("No controller connected"). Real gamepad binding is a separate plan.
- Match timer countdown logic — placeholder display only (no real countdown
  yet).
- FMS simulation — `fmsAttached` stays `false`.
- Tournament/practice mode — single mode for now.

## Dependencies

- **[Plan 03](03-ui-scaffolding.md)** must land first. This plan uses shadcn
  primitives (`Button`, `Tabs`, `Card`, `Tooltip`, `ScrollArea`).
- The HALSim port range is a third port range, parallel to `SIM_PORT_RANGE`
  and `VSCODE_PORT_RANGE`. [Plan 02](02-trim-tests-config.md) (env-var audit)
  doesn't block this but should be aware that `HALSIM_PORT_RANGE` will appear.

## Tasks

### 0. Prove the HALSim WS contract

Before editing the production app:

- Build a minimal local proof using the current
  [templates/wpilib-java-command/build.gradle](../../templates/wpilib-java-command/build.gradle)
  and pinned WPILib/GradleRIO versions.
- Verify the exact Gradle call that enables the WebSocket server
  (`wpi.sim.addWebsocketsServer()` or the current equivalent).
- Verify how to set the listen port (`HALSIMWS_PORT`, Gradle property, or
  current equivalent), whether it can bind only inside the container, and what
  container port must be published.
- Verify the exact WS path (`/`, `/v1/ws`, or other), protocol/subprotocol
  requirements, and the message shape for:
  - `enabled`
  - `autonomous`
  - `test`
  - `eStop`
  - `dsAttached`
  - `allianceStationId`
- Verify readback/ack behavior so `useHalSim` can initialize from authoritative
  state after reconnect.
- Record the findings in `docs/decisions/015-halsim-control-protocol.md` before
  implementing the UI.

**Acceptance:** a small proof script or manual transcript shows a running sim
receiving an Enable/Disable command over HALSim WS and robot code observing the
matching `DriverStation` state.

### 1. Container-side: ensure HALSim WS extension is bundled

- Inspect [templates/wpilib-java-command/build.gradle](../../templates/wpilib-java-command/build.gradle).
  Apply the exact Gradle config proven in task 0. Do not assume the method name
  or defaults if the proof found a different current API.
- Inspect [containers/code/](../../containers/code/) Dockerfile and entrypoint. If sim launches via
  `gradlew simulateJava` (or similar), HALSim WS is enabled automatically when
  the build flag is set. Confirm.
- Use the port configuration proven in task 0. Bind/publish only through the
  control plane's loopback proxy path.

**Acceptance:** Inside a running code container, `curl
http://127.0.0.1:<halsim-port>/<proven-path>` returns a WebSocket upgrade
response (or any HTTP 4xx that indicates the server is listening but expecting
WS).

### 2. Control-plane: HALSim WS proxy route

- Add `HALSIM_PORT_RANGE` env var to [apps/control/src/config.ts](../../apps/control/src/config.ts) with a
  reasonable default (e.g., `34000-34099`).
- Update [apps/control/src/containers.ts](../../apps/control/src/containers.ts) to allocate a third
  loopback port per container and pass it to the container using the port
  configuration proven in task 0. Update the `container_leases` schema if
  needed (migration `006_halsim_port.sql`).
- In [apps/control/src/app.ts](../../apps/control/src/app.ts), add a WebSocket route:
  `/u/{slug}/sim/halsim` → loopback `ws://127.0.0.1:<halsim_port>/`
- Reuse the existing NT4 proxy pattern. Authorization goes through
  `requireWorkspaceOwnership` from [Plan 05](05-auth-and-admin.md) §A.7.2,
  called **before** the WS upgrade response. Origin header validated per
  §A.7.3. Header stripping via the existing `stripHopByHopHeaders` helper.
- If this plan lands before Plan 05, use today's `resolveWorkspaceRequest`
  and migrate to `requireWorkspaceOwnership` as part of Plan 05's auth
  middleware sweep.

**Acceptance:** A test in `apps/control/src/__tests__/proxy.test.ts` proves
that an unauthenticated client gets 401 and an authenticated client can
upgrade and receive at least one message from a running sim.

### 3. Web: `useHalSim` hook

`apps/web/src/hooks/useHalSim.ts`. Connects to `/u/{slug}/sim/halsim`. State:

- `connected: boolean`
- `enabled: boolean`
- `mode: "auto" | "teleop" | "test"`
- `eStopped: boolean`
- `alliance: "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3"`

Actions:

- `setEnabled(value: boolean)` — sends `{ ">enabled": value }`
- `setMode(mode)` — sends `{ ">autonomous": mode === "auto", ">test":
  mode === "test" }`
- `setEStop(value)` — sends `{ ">eStop": value }`
- `setAlliance(station)` — sends `{ ">allianceStationId": <enum> }`

The hook reconnects on disconnect with exponential backoff (start 500ms, cap
10s, reset on success), matching `useRunChannel`'s pattern from
[Plan 03](03-ui-scaffolding.md). It wires `dsAttached` to true while connected
and exposes a `connection` value so the StatusReadout can show
"Comms ●" red/amber/green.

**Multi-tab note:** if a student opens two tabs of the same workspace, both
tabs connect to the same HALSim WS and both can issue Enable/Mode commands.
Last-write-wins on the WS, and the two tabs' UI state will diverge — that's
acceptable. Closing the second tab and refreshing the first must restore a
coherent UI from authoritative state (HALSim WS reads + run-status HTTP).
**No leader-election or cross-tab coordination is in scope here.**

### 4. Web: `DriverStation` component tree

Folder `apps/web/src/components/DriverStation/`:

```
DriverStation.tsx       # Top-level layout, mounts the others
OperationsPanel.tsx     # Big Enable button, Mode tabs (Auto/Teleop/Test), E-stop
SimControls.tsx         # Start / Stop / Restart wired to /run
StatusReadout.tsx       # Robot Code | Comms | Joysticks LEDs, mode pill
ConsolePanel.tsx        # Tabbed: "Robot Console" / "DS Log"
JoystickPanel.tsx       # Placeholder "No controller connected"
MatchTimer.tsx          # Visual placeholder only
```

**Layout reference (rough):**

```
┌────────────────────────────────────────────────────────────────┐
│  [Enable/Disable]   [Auto] [Teleop] [Test]    Robot Code ●     │
│                                                Comms     ●     │
│                                                Joysticks ●     │
├────────────────────────────────────────────────────────────────┤
│  Sim: [Start] [Stop] [Restart]   Mode: TELEOP   00:00         │
├────────────────────────────────────────────────────────────────┤
│  Console: [Robot] [DS Log]                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ...log lines...                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

Use shadcn `Tabs` for the console tabs and the mode selector. Use `Button`
with the `destructive` variant for E-stop. Use `Tooltip` to explain the
status LEDs on hover.

### 5. Replace `RunControls` and `ConsolePane` from Plan 03

- Delete `apps/web/src/components/RunControls.tsx`.
- Delete `apps/web/src/components/ConsolePane.tsx`.
- Update `apps/web/src/components/IDELayout.tsx` so the bottom pane mounts
  `<DriverStation />` instead of the two old components.
- The DS console (Robot Console tab) consumes the same log stream from
  `useRunChannel` that the old `ConsolePane` did.

### 6. Safety logic

- Enable / mode buttons are disabled (visually + functionally) until:
  - Container status is `running`.
  - Run status is `running` (sim process up, not just the container).
  - HALSim WS is `connected`.
- Disable + E-stop are unconditional and should fire even when the UI thinks
  the sim is mid-startup (better safe).
- Switching modes while enabled should immediately disable, switch, then
  require a fresh Enable. SystemCore behavior — protects against accidentally
  ramming a robot.
- Stop Sim while enabled: implicitly Disable first (send disable on the WS,
  wait for ack briefly, then send stop to `/run`).

### 7. Visual: SystemCore-ish look

Match SystemCore where reasonable:

- Color-coded mode pills: Auto = orange, Teleop = blue, Test = purple,
  Disabled = grey.
- Large Enable button. Green when enabled, red ringed-outline when disabled.
- Status LEDs are filled circles; green = OK, red = error/disconnected,
  amber = warning.

The user is the design judge — prototype, screenshot, iterate.

### 8. Decision log

Write `docs/decisions/015-halsim-control-protocol.md` capturing:

- Why HALSim WebSocket extension over NT4 control words (WPILib-blessed,
  protocol stability, alignment with AdvantageScope's "Control Sim" panel).
- The third loopback port range (`HALSIM_PORT_RANGE`) and why we don't
  expose it directly.
- Acceptance that multi-tab control is not coordinated.
- Future hooks the decision leaves open: gamepad binding, FMS sim,
  match-timer countdown.

### 9. Tests

- Control-plane: HALSim WS proxy auth + happy-path message passthrough
  (proxy.test.ts).
- Web: a unit test for `useHalSim` hook against a mocked WebSocket — verifies
  enable/disable serialization and state transitions.
- Web: a component test for `OperationsPanel` — Enable button disables itself
  when `connected=false`, mode switch implicitly disables, E-stop fires
  unconditionally.

## Files modified / created / deleted

**Modified:**
- `containers/code/Dockerfile` (verify HALSim WS available)
- `templates/wpilib-java-command/build.gradle` (enable HALSim WS server)
- `apps/control/src/config.ts` (add `HALSIM_PORT_RANGE`)
- `apps/control/src/containers.ts` (allocate HALSim port)
- `apps/control/src/storage.ts` (lease row carries `halsim_port`)
- `apps/control/src/app.ts` (proxy route)
- `apps/control/src/__tests__/proxy.test.ts` (HALSim auth + happy path)
- `apps/web/src/components/IDELayout.tsx` (mount DS in bottom pane)

**Created:**
- `apps/control/migrations/006_halsim_port.sql`
- `docs/decisions/015-halsim-control-protocol.md`
- `apps/web/src/hooks/useHalSim.ts`
- `apps/web/src/components/DriverStation/DriverStation.tsx`
- `apps/web/src/components/DriverStation/OperationsPanel.tsx`
- `apps/web/src/components/DriverStation/SimControls.tsx`
- `apps/web/src/components/DriverStation/StatusReadout.tsx`
- `apps/web/src/components/DriverStation/ConsolePanel.tsx`
- `apps/web/src/components/DriverStation/JoystickPanel.tsx`
- `apps/web/src/components/DriverStation/MatchTimer.tsx`
- `apps/web/src/components/DriverStation/__tests__/*` (component tests)

**Deleted:**
- `apps/web/src/components/RunControls.tsx`
- `apps/web/src/components/ConsolePane.tsx`

## Verification

1. **Container:** `bun run docker:build:code` — image builds with HALSim WS
   support. Start a container manually and `curl` the HALSim port to confirm
   the server is listening.
2. **Control plane:** `bun run test` — proxy tests for HALSim WS pass.
3. **End-to-end with the student template:**
   - Start the dev stack. Log in as a student.
   - In the editor, add a `System.out.println("teleop tick")` to
     `teleopPeriodic()`.
   - Click Sim Start. Wait for status `running`.
   - Click Enable while in Teleop mode. Console shows "teleop tick" repeating.
   - Click Disable. Console output stops.
   - Switch to Auto. Add a similar print in `autonomousPeriodic()`. Enable.
     Auto print fires; teleop print stops.
   - Switch back to Teleop while enabled — UI auto-disables and requires
     re-Enable. Confirm.
   - Click E-Stop. Robot is e-stopped; Enable button is locked until
     E-Stop is cleared.
   - Click Sim Stop. Confirm the implicit disable-before-stop happens cleanly.
4. **Regression:** AdvantageScope still receives NT4 telemetry through all of
   the above. `scopeStatus === "connected"` throughout.
5. **MCP browser checks:** screenshot the DS panel, confirm visual design
   matches expectations. Check `mcp__Claude_Preview__preview_console_logs` for
   any unhandled errors.
6. **Two-user isolation:** sign in as two students simultaneously. Each one's
   Enable affects only their own sim. Confirm by toggling and watching the
   other student's logs do nothing.
