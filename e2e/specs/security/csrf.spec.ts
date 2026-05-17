/**
 * S21 — state-changing endpoints reject cross-origin requests.
 *
 * The control plane uses SameSite=Lax session cookies, so a cross-origin POST
 * without the cookie should never carry an authenticated session. This test
 * sends a POST with an Origin header from a foreign origin and asserts the
 * server treats it as unauthenticated.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";

test("S21 — cross-origin POST without cookie cannot enable robot", async ({
	page,
	app,
}) => {
	const session = await loginAs(page, app, { name: "Alice" });
	const baseUrl = app.storage.config.baseUrl;

	// No cookie + Origin=evil.com
	const resp = await app.fetch(
		new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				origin: "https://evil.com",
			},
			body: JSON.stringify({ enabled: true }),
		}),
	);
	expect([401, 403]).toContain(resp.status);
});

test("S21 — same-origin POST with cookie works (sanity check)", async ({
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
				origin: baseUrl,
			},
			body: JSON.stringify({ enabled: false }),
		}),
	);
	// Either 200/202 if runtime is connected, or 4xx because no sim is running —
	// we only assert it's *not* an auth failure.
	expect(resp.status).not.toBe(401);
	expect(resp.status).not.toBe(403);
});
