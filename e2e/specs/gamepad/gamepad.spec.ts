/**
 * Gamepad/Keyboard specs from the catalog.
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

test("controller selection survives Stop+Run cycle", async () => {
  test.fixme(true, "Needs gamepad shim + DS data-testids. See useGamepad.test.tsx for shim shape.");
});
test("unplug while enabled sends disable + neutral joystick frame", async () => {
  test.fixme(true, "Needs gamepad shim + HALSim fixture frame inspection wired to UI.");
});
test("gamepad input before Run does not produce no-lease errors", async () => {
  test.fixme(true, "Needs gamepad shim + page console error capture.");
});
test("keyboard input only flows while Keyboard tile has focus", async () => {
  test.fixme(true, "Needs data-testid='ds-keyboard-tile' and HALSim frame inspection.");
});
test("auto chooser refreshes after sim restart", async () => {
  test.fixme(true, "Needs NT4 fake fidelity + chooser data-testids.");
});
