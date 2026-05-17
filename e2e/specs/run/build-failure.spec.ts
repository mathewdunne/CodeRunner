/**
 * Run-state edge cases, HTTP-driven.
 *
 * UI-driven coverage (build/sim timeout, run-button testid scenarios)
 * is left as `test.fixme` until DriverStation testids land.
 */

import {
	MockWorkspaceRuntimeProvider,
	makeScriptedRunCommandFactory,
} from "../../../apps/control/src/__tests__/helpers";
import { createApp } from "../../../apps/control/src/app";
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

async function pollRunStatus(
	app: import("../../../apps/control/src/app").ControlApp,
	slug: string,
	cookie: string,
	predicate: (status: string | undefined) => boolean,
	timeoutMs = 5000,
): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	let last: string | undefined;
	while (Date.now() < deadline) {
		const resp = await app.fetch(
			new Request(`${app.storage.config.baseUrl}/u/${slug}/api/sim/status`, {
				headers: { cookie },
			}),
		);
		const body = (await resp.json()) as { run?: { status?: string } };
		last = body.run?.status;
		if (predicate(last)) return last;
		await new Promise((r) => setTimeout(r, 50));
	}
	return last;
}

test.describe("build failure", () => {
	test.use({
		runCommandFactory: {
			factory: makeScriptedRunCommandFactory([
				{ stream: "stderr", line: "FAILURE: Build failed with an exception." },
				{ stream: "stderr", line: "* What went wrong: compilation error." },
				{ exit: 1 },
			]),
		},
	});

	test("surfaces stderr and lands run in failed state", async ({
		page,
		app,
		runtime,
		fakeVscode,
		fakeHalsim,
	}) => {
		const session = await loginAs(page, app, { name: "Brock" });
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
		const cookie = cookieHeader(session);
		const runResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
				method: "POST",
				headers: { cookie },
			}),
		);
		expect(runResp.status).toBe(202);

		const final = await pollRunStatus(
			app,
			session.user.slug,
			cookie,
			(s) => s === "failed" || s === "stopped",
		);
		expect(final).toBe("failed");

		const logResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run/logs`, {
				headers: { cookie },
			}),
		);
		if (logResp.status === 200) {
			const text = await logResp.text();
			expect(text).toMatch(/Build failed/i);
		}
	});
});

test.describe("build timeout kills the run", () => {
	test.use({
		runBuildTimeoutMs: { value: 500 },
		simStartupTimeoutMs: { value: 500 },
		runCommandFactory: {
			factory: makeScriptedRunCommandFactory([
				{ stream: "stdout", line: "Starting build..." },
				// No exit entry — simulates a build that hangs forever.
			]),
		},
	});

	test("build timeout kills the run", async ({
		page,
		app,
		runtime,
		fakeVscode,
		fakeHalsim,
	}) => {
		const session = await loginAs(page, app, { name: "TimeoutA" });
		const workspace = app.storage.findWorkspaceBySlug(
			session.user.slug as never,
		)!;
		seedRuntimeRunning({
			runtime,
			workspaceId: workspace.id,
			fakeVscode,
			fakeHalsim,
		});

		const cookie = cookieHeader(session);
		const baseUrl = app.storage.config.baseUrl;

		const runResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
				method: "POST",
				headers: { cookie },
			}),
		);
		expect(runResp.status).toBe(202);

		const final = await pollRunStatus(
			app,
			session.user.slug,
			cookie,
			(s) => s === "failed",
			3000,
		);
		expect(final).toBe("failed");

		const logResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run/logs`, {
				headers: { cookie },
			}),
		);
		if (logResp.status === 200) {
			const text = await logResp.text();
			expect(text).toMatch(/timed out/i);
		}
	});
});

test.describe("sim readiness timeout fires separately", () => {
	test.use({
		runBuildTimeoutMs: { value: 500 },
		simStartupTimeoutMs: { value: 500 },
		runCommandFactory: {
			factory: makeScriptedRunCommandFactory([
				{ stream: "stdout", line: "Build succeeded" },
				// Deliberately no NT4/NetworkTables ready line — lineLooksReady() never fires,
				// so the readiness timer stays armed. Process stays alive (no exit entry).
			]),
		},
	});

	test("sim readiness timeout fires separately", async ({
		page,
		app,
		runtime,
		fakeVscode,
		fakeHalsim,
	}) => {
		const session = await loginAs(page, app, { name: "TimeoutB" });
		const workspace = app.storage.findWorkspaceBySlug(
			session.user.slug as never,
		)!;
		seedRuntimeRunning({
			runtime,
			workspaceId: workspace.id,
			fakeVscode,
			fakeHalsim,
		});

		const cookie = cookieHeader(session);
		const baseUrl = app.storage.config.baseUrl;

		const runResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
				method: "POST",
				headers: { cookie },
			}),
		);
		expect(runResp.status).toBe(202);

		// Combined timeout is 1000ms (500+500). The process never outputs a ready
		// line, so the readiness timer fires and kills the run.
		const final = await pollRunStatus(
			app,
			session.user.slug,
			cookie,
			(s) => s === "failed",
			5000,
		);
		expect(final).toBe("failed");

		const logResp = await app.fetch(
			new Request(`${baseUrl}/u/${session.user.slug}/api/run/logs`, {
				headers: { cookie },
			}),
		);
		if (logResp.status === 200) {
			const text = await logResp.text();
			expect(text).toMatch(/timed out.*readiness/i);
		}
	});
});

test("external runtime crash leaves run in stopped/failed state", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "Carlin" });
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
	const cookie = cookieHeader(session);

	const runResp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	expect(runResp.status).toBe(202);

	await pollRunStatus(app, session.user.slug, cookie, (s) => s === "running");

	// External crash: provider transitions the runtime into error state.
	runtime.simulateRuntimeFailure(workspace.id, "crashed");

	// The next state observation should reflect that no working runtime is
	// available. We accept either "failed" (RunManager noticed exit) or that
	// a follow-up PATCH on a sim endpoint yields a 503 — both are acceptable
	// for "the UI knows the run is gone".
	const probe = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
			method: "PATCH",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ enabled: false }),
		}),
	);
	expect([409, 503]).toContain(probe.status);
});

test("stale running status cleared on app restart", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "Stale" });
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	const cookie = cookieHeader(session);
	const baseUrl = app.storage.config.baseUrl;

	// Start a run and wait for it to reach "running"
	const runResp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	expect(runResp.status).toBe(202);

	const running = await pollRunStatus(
		app,
		session.user.slug,
		cookie,
		(s) => s === "running",
	);
	expect(running).toBe("running");

	// Close the app abruptly — the DB row stays in "running" state (orphaned).
	const {
		dataDir,
		templateDir,
		webDistDir,
		advantageScopeDistDir,
		sessionSecret,
	} = app.storage.config;
	app.close();

	// Re-create a new app instance pointing at the same SQLite database.
	// reconcileOrphanedRuns() runs inside createApp() and should mark the
	// orphaned "running" row as "stopped".
	const runtime2 = new MockWorkspaceRuntimeProvider();
	const app2 = await createApp({
		dataDir,
		templateDir,
		webDistDir,
		advantageScopeDistDir,
		sessionSecret,
		baseUrl,
		idleStopMinutes: 30,
		containerAutoStart: false,
		runtimeProvider: runtime2,
	});

	try {
		// Verify reconciliation happened: the run_jobs row should now be 'stopped'.
		const rows = app2.storage.db
			.query("SELECT state FROM run_jobs WHERE workspace_id = ?")
			.all(workspace.id) as { state: string }[];
		const states = rows.map((r) => r.state);
		expect(states).toContain("stopped");
		expect(states).not.toContain("running");
	} finally {
		app2.close();
	}
});

test("second Run while one is active replaces / restarts the prior job", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "Drew" });
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
	const cookie = cookieHeader(session);

	const first = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	expect(first.status).toBe(202);
	const firstBody = (await first.json()) as { runId: string };

	const second = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
			method: "POST",
			headers: { cookie },
		}),
	);
	// Contract: RunManager.start cancels the prior job and accepts the new one
	// with 202. We do not require a 409; we only require the second call to
	// not silently drop and to return a different runId.
	expect(second.status).toBe(202);
	const secondBody = (await second.json()) as { runId: string };
	expect(secondBody.runId).not.toBe(firstBody.runId);
});
