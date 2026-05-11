# Decision 015 — HALSim WebSocket Control Protocol

**Status:** accepted
**Date:** 2026-05-10

## Context

The Driver Station UI (Plan 04) needs a control path to toggle
`DriverStation.isEnabled()`, switch between Autonomous/Teleop/Test, and
issue E-stops in the running WPILib robot code. Two candidate protocols exist:

1. **NT4 control words** — NetworkTables 4 does not standardize a control
   interface; any implementation would be ad-hoc and fragile across WPILib
   versions.
2. **HALSim WebSocket extension (`halsim_ws_server`)** — WPILib-blessed
   JSON-over-WebSocket protocol used by AdvantageScope's "Control Sim" panel,
   the Romi/XRP toolchains, and Glass. Stable specification, documented in
   `allwpilib/simulation/halsim_ws_core/doc/hardware_ws_api.md`.

## Decision

Use the HALSim WebSocket extension for all Driver Station control. The control
plane owns one persistent upstream HALSim WebSocket per active workspace and
exposes stateless browser-facing HTTP APIs for state snapshots and desired-state
commands.

The browser does **not** own the HALSim socket. It reads current state from
`GET /u/<slug>/api/sim/status` and sends idempotent commands such as
`PATCH /u/<slug>/api/sim/driver-station` with `{ "enabled": true }`. The
control plane translates those commands into standard `DriverStation` messages,
caches authoritative HALSim readback, and reports stale/disconnected bridge
state explicitly instead of guessing.

The public shape is:

```text
Browser -> stateless HTTP API -> control-plane HALSim bridge -> /wpilibws -> robot sim
```

The existing run/log WebSocket remains responsible for console streaming. It is
not the source of Driver Station state.

`GET /api/openapi.json` remains public. It exposes static route and schema
metadata only, with no workspace identity or simulator state, and gives browser
clients and operators a stable machine-readable description of the stateless
simulation API. Workspace-scoped simulation routes under `/u/<slug>/api/sim/*`
remain authenticated and ownership-checked.

### Rationale

The HALSim WebSocket protocol is persistent by design. WPILib's hardware WS
spec says the resource name is `/wpilibws` and servers should reject a second
connection to the same active resource. Directly proxying each browser tab to
HALSim therefore creates avoidable fragility: refreshes can reset the DS
connection, multiple tabs can race or fail, and the UI cannot reliably recover
state without a live browser-owned socket.

A control-plane bridge matches the rest of V2's architecture: internal ports
stay loopback-only, the browser sees authenticated workspace routes, and every
browser reload can reconstruct state from an HTTP snapshot. The bridge may keep
ephemeral per-workspace state because HALSim itself is WebSocket-based; the
browser-facing API remains stateless and desired-state based.

### Rejected alternatives

- **Browser-owned HALSim proxy.** This was simple for the first Driver Station
  wiring, but it duplicates upstream connections, has weak multi-tab behavior,
  and makes refresh/reopen state recovery dependent on client lifecycle.
- **REST-only without a bridge.** HALSim state/control is WebSocket-native, so a
  control process must still hold a persistent upstream connection somewhere.
- **Unifying console logs into the new sim status API now.** The existing
  `/u/<slug>/ws/run` path already streams build and robot logs. Replacing it is
  unnecessary for Driver Station correctness and would expand the refactor.

### Browser API behavior

- Commands express desired state, not toggles. `PATCH { "enabled": false }` is
  retryable; `POST /toggle-enabled` is not.
- Refreshing or reopening the browser does not intentionally disable the robot.
  Explicit Disable and Stop remain authoritative.
- Changing mode while enabled disables first, matching Driver Station behavior
  in LibDS/QDriverStation and avoiding a mode switch while robot outputs are
  live.
- HALSim readback is authoritative. If the bridge is disconnected, the status
  API returns the last known state with stale connection metadata rather than
  inventing a fresh state.
- Short polling is acceptable for the initial browser status UI. A future
  server-sent events or WebSocket event feed can be added without changing the
  command semantics.

### Protocol details (verified against WPILib 2026.1.1)

| Setting              | Value                   |
|----------------------|-------------------------|
| Gradle config        | `wpi.sim.addWebsocketsServer().defaultEnabled = true` |
| Default port         | `3300`                  |
| Port env var         | `HALSIMWS_PORT`         |
| Bind-address env var | `HALSIMWS_HOST` (set to `0.0.0.0` inside container) |
| WS path              | `/wpilibws`             |

### Message envelope

```json
{ "type": "<MessageType>", "device": "<DeviceId>", "data": { ... } }
```

Data keys are prefixed `<` (output from robot), `>` (input to robot), or
`<>` (bidirectional). The Driver Station UI only sends `>` fields.

### DriverStation message (`type: "DriverStation"`, `device: ""`)

| Key              | Type    | Description                                       |
|------------------|---------|---------------------------------------------------|
| `>new_data`      | bool    | One-shot; notifies robot of new DS + Joystick data |
| `>enabled`       | bool    | Enable / disable robot                            |
| `>autonomous`    | bool    | Autonomous mode                                   |
| `>test`          | bool    | Test mode                                         |
| `>estop`         | bool    | Emergency stop                                    |
| `>fms`           | bool    | FMS connected (leave false)                       |
| `>ds`            | bool    | DS application connected                          |
| `>station`       | string  | `"red1"` … `"blue3"`                              |
| `>match_time`    | float   | Countdown seconds, −1 if not in match             |
| `>game_data`     | string  | Game-specific data                                |

### Joystick message (`type: "Joystick"`, `device: "<N>"`)

| Key          | Type            | Description                          |
|--------------|-----------------|--------------------------------------|
| `>axes`      | float[]         | −1 to 1 per axis                     |
| `>povs`      | int[]           | Angle in degrees, −1 if not pressed  |
| `>buttons`   | bool[]          | True if pressed                      |

Joystick data is held until a `>new_data` pulse on the DriverStation message.

### Readback behavior

On connect, the sim sends the current state of every initialized device,
including the DriverStation. The control-plane HALSim bridge reads these to
initialize its cached state, and browser clients read that cache through the
status API.

## Port allocation

A third loopback port range `HALSIM_PORT_RANGE` (default `34000–34099`)
is allocated per container, parallel to `SIM_PORT_RANGE` (NT4) and
`VSCODE_PORT_RANGE`. The container-internal port 3300 is bound only to
`127.0.0.1:<allocated>` on the host. The browser never connects directly to
that loopback port. The control-plane bridge reaches the sim at
`ws://127.0.0.1:<allocated>/wpilibws`.

## Multi-tab behavior

Multiple tabs of the same workspace share the same control-plane bridge. Tabs
issue idempotent desired-state commands through HTTP; the latest accepted
command wins, and every tab re-syncs from the same status snapshot. No browser
leader election is required.

## Future hooks

- Gamepad binding — send Joystick messages from `navigator.getGamepads()`.
- FMS simulation — set `>fms` to true.
- Match timer countdown — drive `>match_time` from a client-side timer.
- Tournament / practice mode — send mode sequences on a schedule.
