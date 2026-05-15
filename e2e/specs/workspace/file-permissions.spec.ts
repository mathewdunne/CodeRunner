/**
 * T6.1 — Exec failure (permission denied) surfaces correctly.
 *
 * Verifies that when runtime.exec() fails with a permission error (EACCES),
 * subsequent operations that depend on exec succeeding degrade gracefully.
 * Uses the `injectExecFailure` hook on MockWorkspaceRuntimeProvider.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import { makeScriptedRunCommandFactory } from "../../../apps/control/src/__tests__/helpers";

test.describe("file permission errors via exec", () => {
  test.use({
    runCommandFactory: {
      factory: makeScriptedRunCommandFactory([
        { stream: "stdout", line: "Starting build..." },
        { stream: "stdout", line: "Build succeeded" },
        { stream: "stdout", line: "HALSim listening" },
        // Run stays alive; we test stop-sim failure below.
      ]),
    },
  });

  test("exec failure on stop-sim does not crash the server (fire-and-forget)", async ({
    page,
    app,
    runtime,
    fakeVscode,
    fakeHalsim,
  }) => {
    const session = await loginAs(page, app, { name: "PermDenied" });
    const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
    seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

    const baseUrl = app.storage.config.baseUrl;
    const cookie = cookieHeader(session);

    // Inject exec failure: any command containing "stop-sim" returns EACCES.
    runtime.injectExecFailure(
      workspace.id,
      (cmd) => cmd.some((c) => c.includes("stop-sim")),
      { exitCode: 1, stdout: "", stderr: "Permission denied" },
    );

    // Start a run to have something active.
    const runResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(runResp.status).toBe(202);

    // POST /api/run/stop triggers exec("stop-sim.sh") internally.
    // Even though exec fails, the stop endpoint should not 500.
    const stopResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/run/stop`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(stopResp.status).toBeLessThan(500);

    const body = (await stopResp.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("exec failure is recorded in execCalls for observability", async ({
    page,
    app,
    runtime,
    fakeVscode,
    fakeHalsim,
  }) => {
    const session = await loginAs(page, app, { name: "PermObs" });
    const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
    seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

    const baseUrl = app.storage.config.baseUrl;
    const cookie = cookieHeader(session);

    // Inject failure for any tee command (simulates write permission denied).
    runtime.injectExecFailure(
      workspace.id,
      (cmd) => cmd.some((c) => c.includes("tee")),
      { exitCode: 1, stdout: "", stderr: "Permission denied" },
    );

    // Execute a direct exec call to verify the mock intercepts properly.
    const result = await runtime.exec(workspace.id, ["tee", "/tmp/test-file"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("Permission denied");

    // Verify the call was logged.
    const teeCalls = runtime.execCalls.filter((c) =>
      c.command.some((arg) => arg.includes("tee")),
    );
    expect(teeCalls.length).toBeGreaterThanOrEqual(1);
  });
});
