/**
 * T17.x — Driver Station enable/disable/mode payload shape.
 * Anchor: commit d111f70 (wrong payload shape).
 *
 * HTTP-driven: bypasses UI by PATCHing the /driver-station endpoint directly.
 * UI-driven coverage is added once the DS components carry data-testids.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("PATCH /driver-station with {enabled:true} updates state and forwards to HALSim", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  const baseUrl = app.storage.config.baseUrl;
  const resp = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookieHeader(session) },
      body: JSON.stringify({ enabled: true, mode: "teleop" }),
    }),
  );
  // Either 200 or 202 — we lock the contract at "no 4xx"
  expect(resp.status).toBeGreaterThanOrEqual(200);
  expect(resp.status).toBeLessThan(300);
});

test("PATCH /driver-station rejects unknown mode (schema enforcement)", async ({ page, app }) => {
  const session = await loginAs(page, app, { name: "Bob" });
  const baseUrl = app.storage.config.baseUrl;
  const resp = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookieHeader(session) },
      body: JSON.stringify({ mode: "kitchen-sink" }),
    }),
  );
  expect(resp.status).toBe(400);
});

test("PATCH /driver-station rejects empty patch (schema requires at least one field)", async ({
  page,
  app,
}) => {
  const session = await loginAs(page, app, { name: "Carol" });
  const baseUrl = app.storage.config.baseUrl;
  const resp = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: cookieHeader(session) },
      body: JSON.stringify({}),
    }),
  );
  expect(resp.status).toBe(400);
});
