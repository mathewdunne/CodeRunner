/**
 * T31.1 / T32.1 / T32.2 — admin user-management actions.
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

test("T32.1 cannot demote the last admin", async () => {
  test.fixme(
    true,
    "Needs admin user-action endpoint coverage; the storage layer enforces 'at least one " +
      "admin' invariant — verify by attempting self-demote.",
  );
});

test("T32.2 deleting a user removes their workspace", async () => {
  test.fixme(true, "Needs user-delete endpoint + filesystem assertion.");
});
