/**
 * T19.1 — HALSim transient unavailability does not crash the run.
 *
 * Verifies that when the HALSim WS endpoint becomes temporarily unavailable,
 * the run does not transition to `failed` and the system recovers gracefully.
 *
 * NOTE: The fakeHalsim fixture exposes stop() but no restart/reconnect method.
 * Until the fixture supports re-creation or reconnection, the "restart after
 * transient outage" portion cannot be fully validated. The test verifies that
 * stopping HALSim mid-run does not immediately crash the run to `failed`.
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";
import { makeScriptedRunCommandFactory } from "../../../apps/control/src/__tests__/helpers";

async function pollRunStatus(
  app: import("../../../apps/control/src/app").ControlApp,
  slug: string,
  cookie: string,
  predicate: (status: string | undefined) => boolean,
  timeoutMs = 5000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const resp = await app.fetch(
      new Request(`${app.storage.config.baseUrl}/u/${slug}/api/sim/status`, {
        headers: { cookie },
      }),
    );
    const body = (await resp.json()) as { run?: { status?: string } };
    last = body.run?.status;
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

test.describe("HALSim transient unavailability", () => {
  test.use({
    runCommandFactory: {
      factory: makeScriptedRunCommandFactory([
        { stream: "stdout", line: "Build succeeded" },
        { stream: "stdout", line: "NetworkTables listening on 5810" },
        // Process stays alive (no exit entry) to simulate a running sim.
      ]),
    },
  });

  test("stopping HALSim mid-run does not immediately fail the run", async ({
    page,
    app,
    runtime,
    fakeVscode,
    fakeHalsim,
  }) => {
    const session = await loginAs(page, app, { name: "TransientA" });
    const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
    seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

    const baseUrl = app.storage.config.baseUrl;
    const cookie = cookieHeader(session);

    // Start the run.
    const runResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(runResp.status).toBe(202);

    // Wait for the run to reach "running" state.
    const running = await pollRunStatus(app, session.user.slug, cookie, (s) => s === "running");
    expect(running).toBe("running");

    // Simulate transient HALSim unavailability by stopping the fake server.
    await fakeHalsim.stop();

    // Wait a short period — the run should NOT immediately crash.
    await new Promise((r) => setTimeout(r, 300));

    // Poll status: the run should still be "running" (not "failed").
    const statusResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/sim/status`, {
        headers: { cookie },
      }),
    );
    const snapshot = (await statusResp.json()) as { run?: { status?: string } };
    expect(snapshot.run?.status).toBe("running");
  });

  test("HALSim reconnects after transient outage", async () => {
    test.fixme(true, "Needs fakeHalsim fixture to support restart() so we can verify bridge reconnection.");
  });
});
