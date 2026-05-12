# Decision 018: Gamepad Input via HALSim WebSocket

**Date:** 2026-05-12
**Status:** Accepted
**Context:** Students could set DriverStation state (enabled/mode/alliance) but had no way to drive their robot. The `Controls` rail button in the Driver Station UI was a disabled placeholder waiting for this work.

## Summary

Browser polls `navigator.getGamepads()` at ~60 Hz, maps the standard Gamepad API layout to the WPILib XboxController layout, and ships joystick state to the control plane over a dedicated WebSocket at `/u/{slug}/ws/gamepad`. The control plane reuses the existing `HalSimBridge` to emit `Joystick` and `DriverStation` (with `>new_data: true`) messages on the per-workspace HALSim WS connection. v1 supports a single controller bound to WPILib joystick port 0.

## Why HALSim WS, not the FRC DS UDP protocol

[Conductor](https://github.com/Redrield/Conductor) is the prior-art reference for a cross-platform DS-equivalent. It uses `ds-rs` to speak the FRC Driver Station UDP protocol — the protocol a physical robot expects. It is also archived as of 2026 (superseded by `wpilibsuite/FirstDriverStation-Public`).

We are not driving a physical robot; we are driving a simulated robot whose HAL is the HALSim WebSocket plugin running inside the per-student container. That plugin already speaks a well-defined JSON protocol, the control plane already maintains a persistent server-side socket to it for `DriverStation` patches (see `apps/control/src/halsim.ts`), and the same socket can carry `Joystick` messages with one extra method. Bringing in the UDP DS protocol would require a parallel transport, a fake FMS, and would not be useful since the robot code only sees what HAL gives it. HALSim WS reuse is dramatically simpler and matches the existing architecture.

## Why a dedicated WebSocket from browser to control plane

Gamepad input is high-frequency: a polished feel needs 50–60 Hz updates. The three options considered:

1. **Dedicated WebSocket** (chosen). Long-lived, low-latency, clean separation from the run channel.
2. Multiplex over `/ws/run`. Couples unrelated lifecycles; complicates the protocol.
3. HTTP PATCH like `/api/sim/driver-station`. 50 Hz of POSTs is heavy, pollutes logs, and request setup latency adds up.

The new WebSocket reuses the existing auth + origin middleware used by `/ws/run`. Messages are validated by `gamepadClientMessageSchema` in `@frc-sim/contracts`. The browser hook (`useGamepadChannel`) throttles state pushes to ~50 Hz, diffs against the last sent frame, and sends a heartbeat every 250 ms so HALSim sees the joystick alive even when the sticks are still.

## Why a single controller on port 0 for v1

Conductor's UX allows drag-and-drop mapping of multiple controllers to joystick ports 0–5. That feels powerful but adds significant UI work and is unnecessary for the introductory FRC programming flow. Most students will start with the WPILib `CommandXboxController(0)` template. We can extend to multi-port mapping later without breaking the wire protocol — the contract already takes `select`/`release` per workspace, and the bridge methods take an explicit port number.

## Why hand-rolled SVG, not a library

Surveyed:

- `react-gamepads` (whoisryosuke): ships a visualization component but the last release is October 2020. Stale and unmaintained.
- `awesome-react-gamepads`: its visualizer lives in the demo only and is not exported by the npm package.
- `react-gamepad`: input-only, no visualization.

For ~150 lines of SVG we get a viz that matches the existing Tailwind v4 + shadcn aesthetic and doesn't depend on an abandoned package. Visual reference taken from `gamepadviewer.com` and the `awesome-react-gamepads` demo; code is our own.

## Safety: disable on disconnect

Matches Conductor's `apply_joystick_safety` (`/tmp/Conductor/src/input.rs:123` in the cloned reference). Three layers:

1. Browser: when the selected gamepad disappears from `navigator.getGamepads()`, `useGamepad` clears its selection and the parent sends `release` over the WS.
2. Control plane: on receiving `release` or on WS close, `GamepadSessions.closeSession` calls `HalSimBridge.releaseJoystick`, which emits a zeroed `Joystick` payload followed by `DriverStation { ">enabled": false }`.
3. Run lifecycle: `runs.start`/`stop` and idle sweeps call `gamepad.reset(workspaceId)` to drop any stale session state.

## Files Touched

- `packages/contracts/src/index.ts` — `gamepadClientMessageSchema`, `gamepadServerMessageSchema`, `gamepadStateSchema`; expanded `joysticks` shape in `simStatusResponseSchema`.
- `apps/control/src/halsim.ts` — `applyJoystickState`, `releaseJoystick`.
- `apps/control/src/gamepad.ts` — new `GamepadSessions` class.
- `apps/control/src/app.ts` — new `/u/{slug}/ws/gamepad` upgrade route; `simStatusSnapshot` reads gamepad status; run start/stop resets sessions.
- `apps/web/src/hooks/useGamepad.ts`, `useGamepadChannel.ts` — new client hooks.
- `apps/web/src/lib/gamepad-mapping.ts` — Gamepad API → WPILib XboxController mapping.
- `apps/web/src/components/DriverStation/ControlsPanel.tsx` — new panel with inline SVG visualizer.
- `apps/web/src/components/DriverStation/{IconRail,DriverStation,StatusTile,WorkbenchPanel}.tsx` — enable Controls tab and wire joystick status into the existing Joysticks status tile.
- `apps/web/src/routes/WorkspacePage.tsx` — mount the gamepad hook + channel at workspace scope so polling survives panel switches.

## Future Work (Deferred)

- Multi-controller mapping to joystick ports 1–5 (Conductor-style).
- Keyboard input as an alternate source feeding the same WPILib joystick shape.
- Per-device controller profiles (PS4 face button colors, joystick layouts).
- Rumble / haptic feedback (Gamepad API supports it; HALSim does not currently expose a hook).
- Backpressure / ack-based flow control (server `ack` message reserved in the schema but not yet sent).
