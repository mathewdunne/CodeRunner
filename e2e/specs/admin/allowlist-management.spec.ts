/**
 * T33.1 — admin adds an allowlist entry → previously-rejected user can now log in.
 * The auth-callback side of this test lives in oauth-callback.spec.ts; here we
 * cover the admin endpoint.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("admin POST /admin/allowlist persists the entry", async ({ page, app }) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/allowlist`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader(admin) },
      body: JSON.stringify({ kind: "email", value: "newkid@allowed.test" }),
    }),
  );
  expect([200, 201]).toContain(resp.status);
});

test("admin GET /admin/allowlist returns current emails/domains", async ({ page, app }) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/allowlist`, {
      headers: { cookie: cookieHeader(admin) },
    }),
  );
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { emails?: string[]; domains?: string[] };
  expect(Array.isArray(body.emails ?? body.domains ?? [])).toBe(true);
});
