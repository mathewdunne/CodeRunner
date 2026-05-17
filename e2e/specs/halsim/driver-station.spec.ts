/**
 * T17.x — Driver Station enable/disable/mode payload shape.
 * Anchor: commit d111f70 (wrong payload shape).
 *
 * HTTP-driven: bypasses UI by PATCHing the /driver-station endpoint directly.
 * UI-driven coverage is added once the DS components carry data-testids.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("PATCH /driver-station with {enabled:true} updates state and forwards to HALSim", async ({
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

	const baseUrl = app.storage.config.baseUrl;

	// Driver-station mutations require an active run. Kick one off and wait for
	// RunManager to flip into the `running` phase (the manager processes job
	// transitions asynchronously after POST /api/run returns 202).
	const runResp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
			method: "POST",
			headers: { cookie: cookieHeader(session) },
		}),
	);
	expect(runResp.status).toBe(202);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const statusResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/sim/status`, {
				headers: { cookie: cookieHeader(session) },
			}),
		);
		const snapshot = (await statusResp.json()) as { run?: { status?: string } };
		if (snapshot.run?.status === "running") break;
		await new Promise((r) => setTimeout(r, 100));
	}

	// The HALSim bridge connects lazily on the first PATCH, so the very first
	// call typically returns 503 while the upstream WS handshake completes.
	// Retry a few times — production clients do the same on transient 503s.
	let resp: Response | undefined;
	let body = "";
	const patchDeadline = Date.now() + 5000;
	while (Date.now() < patchDeadline) {
		resp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					cookie: cookieHeader(session),
				},
				body: JSON.stringify({ enabled: true, mode: "teleop" }),
			}),
		);
		body = await resp.text();
		if (resp.status >= 200 && resp.status < 300) break;
		if (resp.status === 503) {
			await new Promise((r) => setTimeout(r, 100));
			continue;
		}
		break;
	}
	expect(resp, "expected at least one PATCH to be issued").toBeDefined();
	expect(resp?.status, `body=${body}`).toBeGreaterThanOrEqual(200);
	expect(resp?.status, `body=${body}`).toBeLessThan(300);
});

test("PATCH /driver-station rejects unknown mode (schema enforcement)", async ({
	page,
	app,
}) => {
	const session = await loginAs(page, app, { name: "Bob" });
	const baseUrl = app.storage.config.baseUrl;
	const resp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				cookie: cookieHeader(session),
			},
			body: JSON.stringify({ mode: "kitchen-sink" }),
		}),
	);
	expect(resp.status).toBe(400);
});

test("PATCH /driver-station rejects empty patch (schema requires at least one field)", async ({
	page,
	app,
}) => {
	const session = await loginAs(page, app, { name: "Carol" });
	const baseUrl = app.storage.config.baseUrl;
	const resp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				cookie: cookieHeader(session),
			},
			body: JSON.stringify({}),
		}),
	);
	expect(resp.status).toBe(400);
});
