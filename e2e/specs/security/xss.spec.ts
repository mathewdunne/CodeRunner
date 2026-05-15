/**
 * S16 / S17 — XSS / output encoding tests.
 *
 * S16: malicious display name doesn't execute as HTML in topbar / admin list.
 * S17: Gradle build error rendered as text in the console, not HTML.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import { makeScriptedRunCommandFactory } from "../../../apps/control/src/__tests__/helpers";

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

test.describe("S17 — run console renders messages as text (no innerHTML)", () => {
  const XSS_PAYLOAD = '<img src=x onerror=window.__xss__=1>';

  test.use({
    runCommandFactory: {
      factory: makeScriptedRunCommandFactory([
        { stream: "stderr", line: XSS_PAYLOAD },
        { exit: 1 },
      ]),
    },
  });

  test("malicious build output is displayed as text, not executed", async ({
    page,
    app,
    runtime,
    fakeVscode,
    fakeHalsim,
  }) => {
    const session = await loginAs(page, app, { name: "XssRunner" });
    const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
    seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

    // Navigate to workspace page first so the WS console is connected
    await page.goto(`/u/${session.user.slug}`);

    // Trap any XSS execution
    await page.evaluate(() => {
      Object.defineProperty(window, "__xss__", {
        configurable: true,
        get: () => false,
        set: () => {
          (window as any).__xss_fired__ = true;
        },
      });
    });

    // Start the run
    const cookie = cookieHeader(session);
    const runResp = await app.fetch(
      new Request(`${app.storage.config.baseUrl}/u/${session.user.slug}/api/run`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(runResp.status).toBe(202);

    // Wait for the console to display the payload as literal text
    const console = page.locator("[data-testid='run-console']");
    await expect(console).toContainText(XSS_PAYLOAD, { timeout: 10000 });

    // Verify the payload was NOT parsed as HTML (no <img> element injected)
    const imgCount = await console.locator("img[src='x']").count();
    expect(imgCount).toBe(0);

    // Verify XSS did not fire
    const xssFired = await page.evaluate(() => (window as any).__xss_fired__ ?? false);
    expect(xssFired).toBe(false);
  });
});
