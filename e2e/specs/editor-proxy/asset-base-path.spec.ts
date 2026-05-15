/**
 * T11.1 — every <script>/<link> tag in the workspace shell resolves to a 2xx.
 *
 * The original phrasing pinned `base: "./"` (commit 066141e). That was later
 * reverted to `base: "/"` (commit 1a4f5e6) because the control plane already
 * serves `/assets/*` globally and the workspace-shell route also serves
 * `/u/<slug>/assets/*`. So the contract we actually care about is "the asset
 * URLs in the shell HTML resolve", not "they have a particular shape".
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

test("workspace shell asset references all resolve under both /assets/ and /u/<slug>/assets/", async ({
  page,
  app,
}) => {
  const session = await loginAs(page, app, { name: "Alice" });
  const shell = await app.fetch(
    new Request(`${app.storage.config.baseUrl}/u/${session.user.slug}/`, {
      headers: { cookie: cookieHeader(session) },
    }),
  );
  expect(shell.status).toBe(200);
  const html = await shell.text();

  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = m[1];
    if (!url || url.startsWith("data:") || /^https?:/i.test(url)) continue;
    refs.add(url);
  }
  expect(refs.size).toBeGreaterThan(0);

  for (const ref of refs) {
    const absolute = new URL(ref, `${app.storage.config.baseUrl}/u/${session.user.slug}/`).toString();
    const resp = await app.fetch(
      new Request(absolute, { headers: { cookie: cookieHeader(session) } }),
    );
    expect(resp.status, `asset ${ref} (${absolute}) should resolve`).toBeLessThan(400);
  }
});
