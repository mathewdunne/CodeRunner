/**
 * T11.1 — every <script>/<link> tag in the workspace shell resolves under the
 * workspace base path (`./assets/...` or `/u/<slug>/assets/...`), not
 * `/assets/...` absolute. Anchor: commit 066141e Vite relative base.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("workspace shell uses relative asset paths (Vite `base: \"./\"`)", async ({
  page,
  app,
}) => {
  const session = await loginAs(page, app, { name: "Alice" });
  const resp = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/u/${session.user.slug}/`, {
      headers: { cookie: cookieHeader(session) },
    }),
  );
  expect(resp.status).toBe(200);
  const html = await resp.text();

  // The Vite build with base: "./" produces relative asset references.
  // Catch absolute references that would 404 under /u/<slug>/ unless we set up
  // a global /assets/ handler — the test guards against regressions of 066141e.
  const matches = html.match(/(src|href)="([^"]+)"/g) ?? [];
  for (const m of matches) {
    if (m.includes("http://") || m.includes("https://")) continue;
    if (m.includes('href="data:') || m.includes('src="data:')) continue;
    // Allowed: "./assets/...", "assets/...", or "/u/<slug>/..."
    expect(m).not.toMatch(/=["']\/assets\//);
  }
});
