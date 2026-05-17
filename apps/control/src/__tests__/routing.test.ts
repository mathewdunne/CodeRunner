import { describe, expect, test } from "bun:test";
import { cookieFrom, login, withApp } from "./helpers";

describe("routing and shell APIs", () => {
	test("serves the Vite shell and workspace-prefixed assets after auth", async () => {
		await withApp(async (app) => {
			const response = await login(app, "alice");
			const cookie = cookieFrom(response);

			const shell = await app.fetch(
				new Request("http://localhost/u/alice/", {
					headers: { cookie },
				}),
			);
			expect(shell.status).toBe(200);
			expect(await shell.text()).toContain("V2 test shell");

			const asset = await app.fetch(
				new Request("http://localhost/u/alice/assets/app.js", {
					headers: { cookie },
				}),
			);
			expect(asset.status).toBe(200);
			expect(asset.headers.get("content-type")).toContain("text/javascript");
			expect(await asset.text()).toContain("v2 shell");
		});
	});

	test("serves the favicon from root and workspace-scoped fallback paths", async () => {
		await withApp(async (app) => {
			const rootFavicon = await app.fetch(
				new Request("http://localhost/favicon.ico"),
			);
			expect(rootFavicon.status).toBe(200);
			expect(rootFavicon.headers.get("content-type")).toContain("image/png");

			const workspaceFavicon = await app.fetch(
				new Request("http://localhost/u/alice/coderunner-icon.png"),
			);
			expect(workspaceFavicon.status).toBe(200);
			expect(workspaceFavicon.headers.get("content-type")).toContain(
				"image/png",
			);
		});
	});

	test("returns session and heartbeat for the signed workspace", async () => {
		await withApp(async (app) => {
			const response = await login(app, "alice");
			const cookie = cookieFrom(response);

			const session = await app.fetch(
				new Request("http://localhost/u/alice/api/session", {
					headers: { cookie },
				}),
			);
			expect(session.status).toBe(200);
			expect(await session.json()).toMatchObject({
				user: {
					displayName: "alice",
					avatarUrl: "https://example.test/avatar/alice.png",
				},
				workspace: { slug: "alice" },
			});

			const heartbeat = await app.fetch(
				new Request("http://localhost/u/alice/api/heartbeat", {
					method: "POST",
					headers: {
						cookie,
						"content-type": "application/json",
					},
					body: JSON.stringify({ closing: true }),
				}),
			);
			expect(heartbeat.status).toBe(200);
			expect(await heartbeat.json()).toEqual({ ok: true, closing: true });
		});
	});

	test("rejects API access to another workspace", async () => {
		await withApp(async (app) => {
			const alice = await login(app, "alice");
			const aliceCookie = cookieFrom(alice);
			const bob = await login(app, "bob");
			const bobCookie = cookieFrom(bob);

			const aliceAsBob = await app.fetch(
				new Request("http://localhost/u/bob/api/session", {
					headers: { cookie: aliceCookie },
				}),
			);
			expect(aliceAsBob.status).toBe(403);

			const bobSession = await app.fetch(
				new Request("http://localhost/u/bob/api/session", {
					headers: { cookie: bobCookie },
				}),
			);
			expect(bobSession.status).toBe(200);
			expect(await bobSession.json()).toMatchObject({
				user: { displayName: "bob" },
				workspace: { slug: "bob" },
			});
		});
	});
});
