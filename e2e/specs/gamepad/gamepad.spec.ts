/**
 * Gamepad/Keyboard specs from the catalog.
 *
 * Playwright lacks first-class gamepad APIs, so these tests use an
 * `addInitScript`-injected shim that overrides `navigator.getGamepads`.
 *
 * Anchors: cb9fea6 (selection persistence + no-lease), decision 018 (unplug
 * safety), decision 019 (keyboard focus), 95f450d (auto chooser stale).
 */
import { expect, test } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import {
	connectGamepad,
	installGamepadShim,
	setGamepadAxes,
} from "../../fixtures/gamepad-shim";
import { seedRuntimeRunning } from "../../fixtures/runtime";

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
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

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
		(e) =>
			e.toLowerCase().includes("lease") ||
			e.toLowerCase().includes("not running"),
	);
	expect(leaseErrors).toEqual([]);
});

// Removed: controller selection (T20.1), unplug safety (T21.1), keyboard focus (T23.1),
// auto chooser refresh (T24.1). These required data-testids or gamepad shim fidelity
// that don't exist. See decision 022 and testing-followups.md.
