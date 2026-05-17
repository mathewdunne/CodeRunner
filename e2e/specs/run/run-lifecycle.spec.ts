/**
 * Run → build → running → stop, driven through the run-button / stop-
 * button testids. We assert the status pill's `data-run-status` attribute
 * rather than its visible text because the visible label is icon-only.
 */
import { expect, test } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import { WorkspacePage } from "../../page-objects/workspace.po";

test("run → build → running → stop", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
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

	const wsp = new WorkspacePage(page, session.user.slug);
	await wsp.goto();

	const status = page.getByTestId("ds-status");
	await expect(status).toHaveAttribute("data-run-status", /idle|stopped/);

	await wsp.startRun();
	await expect(status).toHaveAttribute("data-run-status", /building|running/);

	await wsp.stopRun();
	await expect(status).toHaveAttribute("data-run-status", /stopped|idle/);
});
