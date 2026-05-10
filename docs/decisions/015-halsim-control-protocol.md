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

Use the HALSim WebSocket extension for all Driver Station control. The web
app connects through a control-plane proxy and sends standard `DriverStation`
messages to the sim.

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
including the DriverStation. The `useHalSim` hook reads these to initialize
its local state (important for reconnect coherence).

## Port allocation

A third loopback port range `HALSIM_PORT_RANGE` (default `34000–34099`)
is allocated per container, parallel to `SIM_PORT_RANGE` (NT4) and
`VSCODE_PORT_RANGE`. The container-internal port 3300 is bound only to
`127.0.0.1:<allocated>` on the host. The browser never connects directly;
it reaches the sim through the authenticated proxy at
`/u/<slug>/sim/halsim`.

## Multi-tab behavior

Multiple tabs of the same workspace both connect to the same HALSim WS
through the proxy. Last-write-wins on the WS; UI state may diverge between
tabs. Closing one tab and refreshing the other re-syncs from authoritative
HALSim readback. **No leader-election or cross-tab coordination is in
scope.**

## Future hooks

- Gamepad binding — send Joystick messages from `navigator.getGamepads()`.
- FMS simulation — set `>fms` to true.
- Match timer countdown — drive `>match_time` from a client-side timer.
- Tournament / practice mode — send mode sequences on a schedule.
