/**
 * Admin role enforcement on /admin/.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";

test("student cannot GET /admin/status (403)", async ({ page, app }) => {
	const student = await loginAs(page, app, { name: "Student" });
	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/admin/status`, {
			headers: { cookie: cookieHeader(student) },
		}),
	);
	expect(resp.status).toBe(403);
});

test("admin can GET /admin/status", async ({ page, app }) => {
	const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/admin/status`, {
			headers: { cookie: cookieHeader(admin) },
		}),
	);
	expect(resp.status).toBe(200);
	const body = (await resp.json()) as { ok: boolean };
	expect(body.ok).toBe(true);
});
