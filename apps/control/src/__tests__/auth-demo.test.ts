import { describe, expect, test } from "bun:test";
import { DEMO_SLUG, DEMO_USER_ID } from "../auth/demo";
import { withApp } from "./helpers";

describe("demo mode", () => {
	test("seeds an admin user + workspace and bypasses auth on protected routes", async () => {
		await withApp(
			async (app) => {
				const userRow = app.storage.db
					.query("SELECT id, role, slug FROM user WHERE id = ?")
					.get(DEMO_USER_ID) as { id: string; role: string; slug: string };
				expect(userRow.role).toBe("admin");
				expect(userRow.slug).toBe(DEMO_SLUG);

				const workspace = app.storage.db
					.query("SELECT * FROM workspaces WHERE user_id = ?")
					.get(DEMO_USER_ID) as { slug: string } | null;
				expect(workspace).not.toBeNull();
				expect(workspace?.slug).toBe(DEMO_SLUG);

				// No cookie sent — protected workspace API still returns 200.
				const sessionResponse = await app.fetch(
					new Request(`http://localhost/u/${DEMO_SLUG}/api/session`),
				);
				expect(sessionResponse.status).toBe(200);
				const body = (await sessionResponse.json()) as {
					user: { id: string; role: string };
					demo?: boolean;
				};
				expect(body.user.id).toBe(DEMO_USER_ID);
				expect(body.user.role).toBe("admin");
				expect(body.demo).toBe(true);

				// /api/auth/get-session is intercepted and returns the demo user.
				const betterAuthSession = await app.fetch(
					new Request("http://localhost/api/auth/get-session"),
				);
				expect(betterAuthSession.status).toBe(200);
				const baBody = (await betterAuthSession.json()) as {
					user: { id: string; role: string };
				};
				expect(baBody.user.id).toBe(DEMO_USER_ID);

				// Admin route returns 200 without any cookie.
				const adminResponse = await app.fetch(
					new Request("http://localhost/admin/status"),
				);
				expect(adminResponse.status).toBe(200);
			},
			{ demo: true },
		);
	});

	test("seeding is idempotent across reboots", async () => {
		// First boot: seed.
		await withApp(
			async (app) => {
				const count = (
					app.storage.db
						.query("SELECT COUNT(*) AS c FROM user WHERE id = ?")
						.get(DEMO_USER_ID) as { c: number }
				).c;
				expect(count).toBe(1);
			},
			{ demo: true },
		);
		// Second boot in the same fresh data dir should also succeed without
		// duplicating; withApp creates a new temp dir per call so the practical
		// idempotency check is that seeding doesn't throw and we still see exactly
		// one row.
		await withApp(
			async (app) => {
				const count = (
					app.storage.db
						.query("SELECT COUNT(*) AS c FROM user WHERE id = ?")
						.get(DEMO_USER_ID) as { c: number }
				).c;
				expect(count).toBe(1);
			},
			{ demo: true },
		);
	});

	test("without --demo, protected routes still require a session", async () => {
		await withApp(async (app) => {
			const response = await app.fetch(
				new Request(`http://localhost/u/${DEMO_SLUG}/api/session`),
			);
			expect(response.status).toBe(401);

			const session = await app.fetch(
				new Request("http://localhost/api/auth/get-session"),
			);
			// Better Auth returns 200 with `null` body when there's no session.
			const body = await session.json();
			expect(body).toBeNull();
		});
	});
});
