/**
 * Gamepad/Keyboard specs from the catalog (T20–T24).
 *
 * Playwright lacks first-class gamepad APIs, so these tests require an
 * `addInitScript`-injected shim that overrides `navigator.getGamepads`. They
 * also require data-testids on the DriverStation gamepad/keyboard tiles to
 * drive selection and focus.
 *
 * Anchors: cb9fea6 (selection persistence + no-lease), decision 018 (unplug
 * safety), decision 019 (keyboard focus), 95f450d (auto chooser stale).
 */
import { test } from "@playwright/test";

test("T20.1 controller selection survives Stop+Run cycle", async () => {
  test.fixme(true, "Needs gamepad shim + DS data-testids. See useGamepad.test.tsx for shim shape.");
});
test("T21.1 unplug while enabled sends disable + neutral joystick frame", async () => {
  test.fixme(true, "Needs gamepad shim + HALSim fixture frame inspection wired to UI.");
});
test("T22.1 gamepad input before Run does not produce no-lease errors", async () => {
  test.fixme(true, "Needs gamepad shim + page console error capture.");
});
test("T23.1 keyboard input only flows while Keyboard tile has focus", async () => {
  test.fixme(true, "Needs data-testid='ds-keyboard-tile' and HALSim frame inspection.");
});
test("T24.1 auto chooser refreshes after sim restart", async () => {
  test.fixme(true, "Needs NT4 fake fidelity + chooser data-testids.");
});
