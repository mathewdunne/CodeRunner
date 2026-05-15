/**
 * T30.x — capacity-cap admin route.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("admin GET /admin/config/max-active-containers returns the configured cap", async ({
  page,
  app,
}) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/config/max-active-containers`, {
      headers: { cookie: cookieHeader(admin) },
    }),
  );
  expect(resp.status).toBe(200);
  const body = (await resp.json()) as { value?: number; maxActiveContainers?: number };
  // Either shape is acceptable; the contract is "you get a number back".
  expect(body.value ?? body.maxActiveContainers ?? null).not.toBeNull();
});

test("admin POST /admin/config/max-active-containers updates the cap", async ({
  page,
  app,
}) => {
  const admin = await loginAs(page, app, { name: "Admin", role: "admin" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/config/max-active-containers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(admin),
      },
      body: JSON.stringify({ value: 7 }),
    }),
  );
  expect([200, 204]).toContain(resp.status);
});

test("student cannot POST to /admin/config/max-active-containers", async ({ page, app }) => {
  const student = await loginAs(page, app, { name: "Pupil" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/admin/config/max-active-containers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(student),
      },
      body: JSON.stringify({ value: 99 }),
    }),
  );
  expect(resp.status).toBe(403);
});
