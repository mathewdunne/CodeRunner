/**
 * T18.1 — Two tabs of the same workspace stay in DS sync (decision 015).
 *
 * HTTP-driven: the driver-station state lives server-side, so "sync" means
 * any client hitting the same status endpoint sees the mutation made by
 * another client. We PATCH enable from one logical tab, then GET /sim/status
 * to confirm the state is reflected — exactly as a second browser tab would.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("two tabs reflect Enable from either tab", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "Dave" });
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	const baseUrl = app.storage.config.baseUrl;
	const slug = session.user.slug;
	const cookie = cookieHeader(session);

	// Start a run so driver-station mutations are accepted.
	const runResp = await app.fetch(
		new Request(`${baseUrl}/u/${slug}/api/run`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	expect(runResp.status).toBe(202);

	// Wait for the run to reach `running`.
	const runDeadline = Date.now() + 5_000;
	while (Date.now() < runDeadline) {
		const sr = await app.fetch(
			new Request(`${baseUrl}/u/${slug}/api/sim/status`, {
				headers: { cookie },
			}),
		);
		const snap = (await sr.json()) as { run?: { status?: string } };
		if (snap.run?.status === "running") break;
		await new Promise((r) => setTimeout(r, 100));
	}

	// --- "Tab A" sends an enable command ---
	let patchResp: Response | undefined;
	const patchDeadline = Date.now() + 5_000;
	while (Date.now() < patchDeadline) {
		patchResp = await app.fetch(
			new Request(`${baseUrl}/u/${slug}/api/sim/driver-station`, {
				method: "PATCH",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({ enabled: true, mode: "teleop" }),
			}),
		);
		if (patchResp.status >= 200 && patchResp.status < 300) break;
		if (patchResp.status === 503) {
			await new Promise((r) => setTimeout(r, 100));
			continue;
		}
		break;
	}
	expect(patchResp).toBeDefined();
	expect(patchResp?.status).toBeGreaterThanOrEqual(200);
	expect(patchResp?.status).toBeLessThan(300);

	// --- "Tab B" queries the same status endpoint and sees the enable ---
	const statusResp = await app.fetch(
		new Request(`${baseUrl}/u/${slug}/api/sim/status`, { headers: { cookie } }),
	);
	expect(statusResp.status).toBe(200);
	const status = (await statusResp.json()) as {
		driverStation?: { enabled?: boolean; mode?: string };
	};
	expect(status.driverStation?.enabled).toBe(true);
	expect(status.driverStation?.mode).toBe("teleop");

	// Verify the HALSim bridge also received the enable frame.
	const frames = fakeHalsim.receivedFrames();
	expect(frames.length).toBeGreaterThan(0);
});
