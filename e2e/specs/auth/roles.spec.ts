/**
 * T4.1 / T4.2 — admin role enforcement on /admin/.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("T4.1 student cannot GET /admin/status (403)", async ({ page, app }) => {
  const student = await loginAs(page, app, { name: "Student" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/status`, {
      headers: { cookie: cookieHeader(student) },
    }),
  );
  expect(resp.status).toBe(403);
});

test("T4.2 admin can GET /admin/status", async ({ page, app }) => {
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
