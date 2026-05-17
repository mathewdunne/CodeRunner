import { describe, expect, test } from "bun:test";
import {
	cookieFrom,
	createFakeDocker,
	login,
	withApp,
	workspaceBySlug,
} from "./helpers";

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
