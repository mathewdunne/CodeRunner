# Decision 019: Keyboard Input Mode

**Status:** Accepted  
**Date:** 2026-05-13

## Context

Students can drive robot code through a physical controller over `/u/{slug}/ws/gamepad`, but not every learner has an Xbox-compatible controller available. We need a keyboard option that reaches the same `CommandXboxController(0)` path without adding a second simulator protocol.

## Decision

The web shell adds Keyboard as a second input mode beside Controller. Keyboard mode selects a virtual source named `Keyboard (Standard Xbox)` on the existing gamepad WebSocket and sends the same `GamepadState` shape used by the HALSim joystick bridge.

Keyboard input is captured only while the Keyboard tile in the Controls panel has focus. Blur clears all pressed keys and pushes a neutral joystick frame. This makes keyboard driving deliberate and avoids leaking editor or form keystrokes into robot control.

The mapping is derived from the in-repo `Simulation Key Mapping.html` Standard Xbox layout and represented as TypeScript constants so the runtime conversion, mapping dialog, and tests share one source:

- Left stick: `W/A/S/D`
- Right stick: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
- Triggers and bumpers: `Q/O`, `E/U`
- Face and menu buttons: `K/L/J/I`, `R/Y`
- Stick clicks: `F/H`
- POV: `Z/X/C/V`

## Consequences

- No backend or shared contract changes are required.
- Existing HALSim safety behavior for `select`, `release`, and neutral joystick state remains the only server-side path.
- Physical controllers stay the default input mode. The selected mode is persisted in client UI state, but pressed keyboard keys are never persisted.
