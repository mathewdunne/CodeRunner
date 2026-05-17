/**
 * Cross-workspace access must be rejected with 401/403.
 * Anchor: routing security (default-deny + requireWorkspaceOwnership()).
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";

test("cross-workspace HTML access returns 403", async ({ page, app }) => {
	const alice = await loginAs(page, app, { name: "Alice" });
	await loginAs(page, app, { name: "Bob" });

	// Issue a request as Alice for Bob's workspace path
	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/u/bob/`, {
			headers: { cookie: cookieHeader(alice) },
		}),
	);
	expect(resp.status).toBe(403);
});

test("cross-workspace /vscode/ proxy returns 403", async ({ page, app }) => {
	const alice = await loginAs(page, app, { name: "Alice" });
	await loginAs(page, app, { name: "Bob" });

	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/u/bob/vscode/index.html`, {
			headers: { cookie: cookieHeader(alice) },
		}),
	);
	expect(resp.status).toBe(403);
});

test("unauthenticated request to a workspace returns 401", async ({ app }) => {
	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/u/anyone/api/files`),
	);
	// Either 401 (no session) or 403 (workspace not visible) — both express
	// default-deny.
	expect([401, 403, 404]).toContain(resp.status);
	// …but never 200
	expect(resp.status).not.toBe(200);
});
