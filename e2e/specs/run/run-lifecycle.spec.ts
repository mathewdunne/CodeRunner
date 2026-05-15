/**
 * T12.1 — Run → build → running → stop full lifecycle through the UI.
 *
 * Requires data-testids on: run-button, stop-button, run-console, run-status.
 * Tracked as a fixme until those land in apps/web/src/components/.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import { WorkspacePage } from "../../page-objects/workspace.po";

test("T12.1 Run → build → running → stop", async ({ page, app, runtime, fakeVscode, fakeHalsim }) => {
  test.fixme(
    true,
    "Needs data-testids on run-button, stop-button, run-console, run-status in apps/web/src/components/.",
  );

  const session = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  const wsp = new WorkspacePage(page, session.user.slug);
  await wsp.goto();
  await expect(wsp.runStatus()).toHaveText("idle");
  await wsp.startRun();
  await expect(wsp.runStatus()).toHaveText(/building|running/);
  await wsp.stopRun();
  await expect(wsp.runStatus()).toHaveText("stopped");
});
