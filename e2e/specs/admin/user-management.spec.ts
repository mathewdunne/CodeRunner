/**
 * T31.1 — admin user-management actions (read-only path).
 *
 * T32.1 / T32.2 (cannot-demote-last-admin, delete-removes-workspace) were
 * dropped from scope: the corresponding HTTP endpoints don't exist yet and
 * storage-layer invariants are the only enforcement today.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("admin GET /admin/users returns the user list", async ({ page, app }) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/users`, {
      headers: { cookie: cookieHeader(admin) },
    }),
  );
  expect(resp.status).toBe(200);
});
