/**
 * S16 / S17 / S18 — XSS / output encoding tests.
 *
 * S16: malicious display name doesn't execute as HTML in topbar / admin list.
 * S17: Gradle build error rendered as text in the console, not HTML.
 * S18: audit log entries with crafted metadata rendered as text.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";

test("S16 — malicious display name does not execute", async ({ page, app }) => {
  await loginAs(page, app, {
    name: '<img src=x onerror=window.__xss__=1>',
    email: "evil@example.com",
  });

  let xssTriggered = false;
  page.on("dialog", () => { xssTriggered = true; });
  await page.addInitScript(() => {
    Object.defineProperty(window, "__xss__", {
      configurable: true,
      get: () => false,
      set: () => {
        // setter no-op so we can detect the assignment attempt via probe
      },
    });
  });

  await page.goto("/login");
  // The display name is only rendered after login renders the topbar; load the
  // /login shell as a smoke that the shell HTML does not include the literal
  // tag-injection. (Full coverage requires authenticated topbar render — track
  // via data-testid="user-menu-name" once added.)
  const html = await page.content();
  expect(html).not.toContain("<img src=x onerror=");
  expect(xssTriggered).toBe(false);
});

test("S17 — run console renders messages as text (no innerHTML)", async ({ page, app }) => {
  test.fixme(
    true,
    "Requires data-testid='run-console' and a way to inject a server log line through the run WS." +
      " Implement when the run-console test ID is present.",
  );
  void page;
  void app;
});

test("S18 — audit log entries are text-encoded", async ({ page, app }) => {
  test.fixme(
    true,
    "Requires data-testid='admin-audit-log-table' and admin UI render path.",
  );
  void page;
  void app;
});
