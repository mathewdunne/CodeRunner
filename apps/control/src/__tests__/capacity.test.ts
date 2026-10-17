import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	cookieFrom,
	createFakeDocker,
	login,
	withApp,
	workspaceBySlug,
} from "./helpers";

// Find the fake container for a workspace by its `frc-sim.workspace` label.
function fakeContainerFor(
	fakeDocker: ReturnType<typeof createFakeDocker>,
	workspaceId: string,
) {
	for (const container of fakeDocker.containers.values()) {
		if (container.labels["frc-sim.workspace"] === workspaceId) {
			return container;
		}
	}
	return undefined;
}

// Step past the provider's running-status cache, so a change made directly on
// the fake (behind the provider's back) is seen by the next ensure.
function expireRunningStatusCache() {
	setSystemTime(new Date(Date.now() + 3_000));
}

// Simulate the idle sweep: stop (but do not remove) a workspace's container.
// The real sweep stops through the provider, which drops its cached status.
function stopFakeContainer(
	fakeDocker: ReturnType<typeof createFakeDocker>,
	workspaceId: string,
) {
	const container = fakeContainerFor(fakeDocker, workspaceId);
	if (!container) {
		throw new Error(`no fake container for workspace ${workspaceId}`);
	}
	container.running = false;
	expireRunningStatusCache();
}

afterEach(() => {
	setSystemTime();
});

describe("container concurrency cap", () => {
	test("ensureCodeContainer throws CapacityExceededError when at cap", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				// Cap at 1
				await login(app, "alice");
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);

				await login(app, "bob");
				const bob = workspaceBySlug(app, "bob");
				try {
					await app.containers.ensureCodeContainer(bob);
					expect.unreachable("Should have thrown");
				} catch (error: unknown) {
					expect((error as Error).name).toBe("CapacityExceededError");
				}
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 1,
				simPortRange: { start: 45800, end: 45810 },
				vscodePortRange: { start: 46800, end: 46810 },
				halsimPortRange: { start: 47800, end: 47810 },
			},
		);
	});

	test("containers/status returns 503 when at capacity", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				const aliceRes = await login(app, "alice");
				const aliceCookie = cookieFrom(aliceRes);
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);

				const bobRes = await login(app, "bob");
				const bobCookie = cookieFrom(bobRes);

				const status = await app.fetch(
					new Request("http://localhost/u/bob/api/containers/status", {
						headers: { cookie: bobCookie },
					}),
				);
				expect(status.status).toBe(503);
				const body = (await status.json()) as {
					error: string;
					limit: number;
					current: number;
				};
				expect(body.error).toBe("capacity");
				expect(body.limit).toBe(1);

				// Alice should still work
				const aliceStatus = await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie: aliceCookie },
					}),
				);
				expect(aliceStatus.status).toBe(200);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 1,
				simPortRange: { start: 45820, end: 45830 },
				vscodePortRange: { start: 46820, end: 46830 },
				halsimPortRange: { start: 47820, end: 47830 },
			},
		);
	});

	test("admin can bump cap to allow more containers", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				const adminRes = await login(app, "coach", { role: "admin" });
				const adminCookie = cookieFrom(adminRes);
				await login(app, "alice");
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);

				const bobRes = await login(app, "bob");
				const _bobCookie = cookieFrom(bobRes);

				// At cap=1, bob is rejected
				const bob = workspaceBySlug(app, "bob");
				try {
					await app.containers.ensureCodeContainer(bob);
					expect.unreachable("Should have thrown");
				} catch (error: unknown) {
					expect((error as Error).name).toBe("CapacityExceededError");
				}

				// Bump cap to 2
				const bumpRes = await app.fetch(
					new Request("http://localhost/admin/config/max-active-containers", {
						method: "POST",
						headers: {
							cookie: adminCookie,
							"content-type": "application/json",
						},
						body: JSON.stringify({ value: 2 }),
					}),
				);
				expect(bumpRes.status).toBe(200);

				// Bob should now succeed
				const bobStatus = await app.containers.ensureCodeContainer(bob);
				expect(bobStatus.state).toBe("running");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 1,
				simPortRange: { start: 45840, end: 45850 },
				vscodePortRange: { start: 46840, end: 46850 },
				halsimPortRange: { start: 47840, end: 47850 },
			},
		);
	});

	test("cap persists via runtime_config", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				const adminRes = await login(app, "coach", { role: "admin" });
				const adminCookie = cookieFrom(adminRes);

				await app.fetch(
					new Request("http://localhost/admin/config/max-active-containers", {
						method: "POST",
						headers: {
							cookie: adminCookie,
							"content-type": "application/json",
						},
						body: JSON.stringify({ value: 5 }),
					}),
				);

				expect(app.storage.getEffectiveMaxActiveContainers()).toBe(5);

				// Read it back via the GET endpoint
				const getRes = await app.fetch(
					new Request("http://localhost/admin/config/max-active-containers", {
						headers: { cookie: adminCookie },
					}),
				);
				expect(getRes.status).toBe(200);
				const body = (await getRes.json()) as { maxActiveContainers: number };
				expect(body.maxActiveContainers).toBe(5);
			},
			{
				dockerRunner: fakeDocker.runner,
				maxActiveContainers: 10,
			},
		);
	});

	test("admin status includes maxActiveContainers", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				const adminRes = await login(app, "coach", { role: "admin" });
				const adminCookie = cookieFrom(adminRes);

				const status = await app.fetch(
					new Request("http://localhost/admin/status", {
						headers: { cookie: adminCookie },
					}),
				);
				expect(status.status).toBe(200);
				const body = (await status.json()) as { maxActiveContainers: number };
				expect(body.maxActiveContainers).toBe(3);
			},
			{
				dockerRunner: fakeDocker.runner,
				maxActiveContainers: 3,
			},
		);
	});

	test("restarting a stopped container is rejected when at capacity", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				// Cap at 1. Alice starts a container, then it is stopped (idle sweep
				// stops but does not remove). Bob then fills the only slot.
				await login(app, "alice");
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);
				stopFakeContainer(fakeDocker, alice.id);

				await login(app, "bob");
				const bob = workspaceBySlug(app, "bob");
				await app.containers.ensureCodeContainer(bob);

				// Alice reconnects: adoption would `docker start` her stopped
				// container, which must now be gated by the capacity cap.
				try {
					await app.containers.ensureCodeContainer(alice);
					expect.unreachable("Should have thrown");
				} catch (error: unknown) {
					expect((error as Error).name).toBe("CapacityExceededError");
				}
				// Her container must remain stopped (not restarted past the cap).
				expect(fakeContainerFor(fakeDocker, alice.id)?.running).toBe(false);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 1,
				simPortRange: { start: 45880, end: 45890 },
				vscodePortRange: { start: 46880, end: 46890 },
				halsimPortRange: { start: 47880, end: 47890 },
			},
		);
	});

	test("adopting an already-running container is not gated at capacity", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				// Cap at 1, filled by alice's running container. Re-ensuring for
				// alice adopts her already-running (already-counted) container and
				// must not consume a new slot or be rejected.
				await login(app, "alice");
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);

				const again = await app.containers.ensureCodeContainer(alice);
				expect(again.state).toBe("running");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 1,
				simPortRange: { start: 45900, end: 45910 },
				vscodePortRange: { start: 46900, end: 46910 },
				halsimPortRange: { start: 47900, end: 47910 },
			},
		);
	});

	test("recycling a running container onto a new image keeps its slot", async () => {
		const fakeDocker = createFakeDocker();
		let carolEnsure: Promise<unknown> | null = null;
		let aliceName = "";
		let startCarol = () => {};
		const runner: typeof fakeDocker.runner = async (args) => {
			const result = await fakeDocker.runner(args);
			if (args[0] === "rm" && args[2] === aliceName && !carolEnsure) {
				// Another workspace asks for a slot right after alice's stale
				// container is removed, before her replacement is created.
				startCarol();
				await new Promise((resolveWait) => setTimeout(resolveWait, 50));
			}
			return result;
		};
		await withApp(
			async (app) => {
				// Cap at 2, filled by alice and bob.
				await login(app, "alice");
				await login(app, "bob");
				await login(app, "carol");
				const alice = workspaceBySlug(app, "alice");
				const bob = workspaceBySlug(app, "bob");
				const carol = workspaceBySlug(app, "carol");
				await app.containers.ensureCodeContainer(alice);
				await app.containers.ensureCodeContainer(bob);

				// Alice's container was created from an older workspace image.
				const aliceContainer = fakeContainerFor(fakeDocker, alice.id);
				if (!aliceContainer) throw new Error("no container for alice");
				aliceContainer.labels["frc-sim.image-id"] = "sha256:older";
				aliceName = aliceContainer.name;
				expireRunningStatusCache();
				startCarol = () => {
					carolEnsure = app.containers.ensureCodeContainer(carol);
					carolEnsure.catch(() => {});
				};

				const status = await app.containers.ensureCodeContainer(alice);
				expect(status.state).toBe("running");
				expect(carolEnsure).not.toBeNull();
				await expect(carolEnsure).rejects.toThrow(/capacity/i);
			},
			{
				dockerRunner: runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 2,
				simPortRange: { start: 45950, end: 45960 },
				vscodePortRange: { start: 46950, end: 46960 },
				halsimPortRange: { start: 47950, end: 47960 },
			},
		);
	});

	test("a successful restart below cap releases its slot", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				// Cap at 2. Alice starts then is stopped, leaving 0 running.
				await login(app, "alice");
				const alice = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(alice);
				stopFakeContainer(fakeDocker, alice.id);

				// Restart below cap succeeds.
				const restarted = await app.containers.ensureCodeContainer(alice);
				expect(restarted.state).toBe("running");

				// If the restart leaked a pending slot, this create would be
				// rejected (active = 1 running + 1 leaked = 2 = cap). It must succeed.
				await login(app, "bob");
				const bob = workspaceBySlug(app, "bob");
				const bobStatus = await app.containers.ensureCodeContainer(bob);
				expect(bobStatus.state).toBe("running");

				// Now genuinely at cap: a third workspace is rejected.
				await login(app, "carol");
				const carol = workspaceBySlug(app, "carol");
				try {
					await app.containers.ensureCodeContainer(carol);
					expect.unreachable("Should have thrown");
				} catch (error: unknown) {
					expect((error as Error).name).toBe("CapacityExceededError");
				}
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 2,
				simPortRange: { start: 45920, end: 45940 },
				vscodePortRange: { start: 46920, end: 46940 },
				halsimPortRange: { start: 47920, end: 47940 },
			},
		);
	});

	test("simultaneous ensureCodeContainer calls never exceed cap", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				// Create 5 users, cap at 2
				const users = ["a", "b", "c", "d", "e"];
				for (const name of users) {
					await login(app, name);
				}

				const results = await Promise.allSettled(
					users.map((name) => {
						const ws = workspaceBySlug(app, name);
						return app.containers.ensureCodeContainer(ws);
					}),
				);

				const succeeded = results.filter(
					(r) => r.status === "fulfilled",
				).length;
				const failed = results.filter((r) => r.status === "rejected").length;

				expect(succeeded).toBe(2);
				expect(failed).toBe(3);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				maxActiveContainers: 2,
				simPortRange: { start: 45860, end: 45870 },
				vscodePortRange: { start: 46860, end: 46870 },
				halsimPortRange: { start: 47860, end: 47870 },
			},
		);
	});
});
