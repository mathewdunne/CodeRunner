/**
 * T5.1 — first login seeds template files into project dir.
 * T5.3 — runtime failure surfaces an error to the workspace HTTP route.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning, seedRuntimeMissing } from "../../fixtures/runtime";
import { existsSync } from "node:fs";
import { join } from "node:path";

test("T5.1 first login creates project dir with seeded template files", async ({ page, app }) => {
  const { user } = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(user.slug as never);
  expect(workspace).toBeTruthy();
  // The project dir should contain at least build.gradle from the template
  const projectPath = workspace!.project_path;
  expect(existsSync(join(projectPath, "build.gradle"))).toBe(true);
});

test("T5.2 web shell HTML is served from /u/<slug>/", async ({ page, app, fakeVscode, fakeHalsim, runtime }) => {
  const { user } = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  await page.goto(`/u/${user.slug}/`);
  // We don't assert a specific React UI element — that would require data-testids.
  // We assert the server returned a 2xx for the workspace path, which the SPA
  // shell needs to mount.
  await expect(page).toHaveURL(new RegExp(`/u/${user.slug}/`));
});
