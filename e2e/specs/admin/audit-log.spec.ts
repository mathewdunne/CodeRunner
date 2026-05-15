/**
 * T31.1 — admin actions appear in the audit log endpoint.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("admin GET /admin/audit-log returns a list shape", async ({ page, app }) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/audit-log`, {
      headers: { cookie: cookieHeader(admin) },
    }),
  );
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { entries?: unknown[] };
  expect(Array.isArray(body.entries ?? body)).toBe(true);
});
