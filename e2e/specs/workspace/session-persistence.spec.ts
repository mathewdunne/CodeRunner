/**
 * T7.1 — Session persistence: navigating away and back does not duplicate runtimes.
 *
 * Verifies that when a user navigates to their workspace, leaves, and returns,
 * the system does not spin up a duplicate runtime — only one remains running.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("navigating away and back does not create duplicate runtimes", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Persist" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  // Navigate to the workspace page (triggers ensureWorkspaceRunning if containerAutoStart).
  await page.goto(`/u/${session.user.slug}/`);
  await expect(page).toHaveURL(new RegExp(`/u/${session.user.slug}/`));

  // Verify one running workspace.
  const countBefore = await runtime.countRunningWorkspaces();
  expect(countBefore).toBe(1);

  // Navigate away to the login/home page.
  await page.goto("/");

  // Navigate back to the workspace.
  await page.goto(`/u/${session.user.slug}/`);
  await expect(page).toHaveURL(new RegExp(`/u/${session.user.slug}/`));

  // Verify still only one running workspace — no duplicate created.
  const countAfter = await runtime.countRunningWorkspaces();
  expect(countAfter).toBe(1);
});

test("runtime stays active across page reloads", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Reload" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  await page.goto(`/u/${session.user.slug}/`);
  await expect(page).toHaveURL(new RegExp(`/u/${session.user.slug}/`));

  // Reload the page multiple times.
  await page.reload();
  await page.reload();

  // Still only one running workspace.
  const count = await runtime.countRunningWorkspaces();
  expect(count).toBe(1);

  // Runtime state should still be "running".
  const status = await runtime.getWorkspaceStatus(workspace.id);
  expect(status.state).toBe("running");
});
