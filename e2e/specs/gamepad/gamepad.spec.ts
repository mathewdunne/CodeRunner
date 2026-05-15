/**
 * Gamepad/Keyboard specs from the catalog.
 *
 * Playwright lacks first-class gamepad APIs, so these tests use an
 * `addInitScript`-injected shim that overrides `navigator.getGamepads`.
 *
 * Anchors: cb9fea6 (selection persistence + no-lease), decision 018 (unplug
 * safety), decision 019 (keyboard focus), 95f450d (auto chooser stale).
 */
import { test, expect } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import {
  installGamepadShim,
  connectGamepad,
  setGamepadAxes,
} from "../../fixtures/gamepad-shim";

test("gamepad input before Run does not produce no-lease errors", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  // Install shim before navigation
  await installGamepadShim(page);

  const session = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  // Capture console errors
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Navigate to the workspace page
  await page.goto(`/u/${session.user.slug}`);
  await page.waitForLoadState("networkidle");

  // Connect a virtual gamepad and move sticks BEFORE starting a run
  await connectGamepad(page, 0);
  await setGamepadAxes(page, 0, [0.5, -0.5, 0, 0]);

  // Give any error handlers time to fire
  await page.waitForTimeout(500);

  // Verify no "no-lease" or similar errors appeared
  const leaseErrors = consoleErrors.filter(
    (e) => e.toLowerCase().includes("lease") || e.toLowerCase().includes("not running"),
  );
  expect(leaseErrors).toEqual([]);
});

test("controller selection survives Stop+Run cycle", async () => {
  test.fixme(
    true,
    "Needs data-testid on gamepad selector dropdown to programmatically select and verify persistence across stop/start.",
  );
});

test("unplug while enabled sends disable + neutral joystick frame", async () => {
  test.fixme(
    true,
    "Gamepad shim triggers TypeError in useGamepad hook iteration. Needs debugging of the RAF polling " +
    "loop's interaction with the addInitScript shim — the Gamepad objects from the shim lack the " +
    "iterable protocol that the hook expects on the buttons array.",
  );
});

test("keyboard input only flows while Keyboard tile has focus", async () => {
  test.fixme(
    true,
    "Needs data-testid='ds-keyboard-tile' on the KeyboardTile component to programmatically focus/blur and verify HALSim frames.",
  );
});

test("auto chooser refreshes after sim restart", async () => {
  test.fixme(true, "Needs NT4 fake fidelity + chooser data-testids.");
});
