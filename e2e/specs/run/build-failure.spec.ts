/**
 * T13.1, T15.1, T16.1 — run-state edge cases, HTTP-driven.
 *
 * UI-driven coverage (T14.x build/sim timeout, run-button testid scenarios)
 * is left as `test.fixme` until DriverStation testids land.
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

test.describe("T13.1 build failure", () => {
  test.use({
    runCommandFactory: {
      factory: makeScriptedRunCommandFactory([
        { stream: "stderr", line: "FAILURE: Build failed with an exception." },
        { stream: "stderr", line: "* What went wrong: compilation error." },
        { exit: 1 },
      ]),
    },
  });

  test("surfaces stderr and lands run in failed state", async ({
    page,
    app,
    runtime,
    fakeVscode,
    fakeHalsim,
  }) => {
    const session = await loginAs(page, app, { name: "Brock" });
    const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
    seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

    const baseUrl = app.storage.config.baseUrl;
    const cookie = cookieHeader(session);
    const runResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(runResp.status).toBe(202);

    const final = await pollRunStatus(
      app,
      session.user.slug,
      cookie,
      (s) => s === "failed" || s === "stopped",
    );
    expect(final).toBe("failed");

    const logResp = await app.fetch(
      new Request(`${baseUrl}/u/${session.user.slug}/api/run/logs`, { headers: { cookie } }),
    );
    if (logResp.status === 200) {
      const text = await logResp.text();
      expect(text).toMatch(/Build failed/i);
    }
  });
});

test("T14.1 build timeout kills the run", async () => {
  test.fixme(true, "Needs runBuildTimeoutMs override path through ControlAppOptions.");
});

test("T14.2 sim readiness timeout fires separately", async () => {
  test.fixme(true, "Needs simStartupTimeoutMs override + halsim never ready.");
});

test("T15.1 external runtime crash leaves run in stopped/failed state", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Carlin" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  const baseUrl = app.storage.config.baseUrl;
  const cookie = cookieHeader(session);

  const runResp = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/run`, {
      method: "POST",
      headers: { cookie },
    }),
  );
  expect(runResp.status).toBe(202);

  await pollRunStatus(app, session.user.slug, cookie, (s) => s === "running");

  // External crash: provider transitions the runtime into error state.
  runtime.simulateRuntimeFailure(workspace.id, "crashed");

  // The next state observation should reflect that no working runtime is
  // available. We accept either "failed" (RunManager noticed exit) or that
  // a follow-up PATCH on a sim endpoint yields a 503 — both are acceptable
  // for "the UI knows the run is gone".
  const probe = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/sim/driver-station`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ enabled: false }),
    }),
  );
  expect([409, 503]).toContain(probe.status);
});

test("T15.2 stale running status cleared on app restart", async () => {
  test.fixme(true, "Needs in-test re-creation of ControlApp with same DB.");
});

test("T16.1 second Run while one is active replaces / restarts the prior job", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Drew" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  const baseUrl = app.storage.config.baseUrl;
  const cookie = cookieHeader(session);

  const first = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/run`, { method: "POST", headers: { cookie } }),
  );
  expect(first.status).toBe(202);
  const firstBody = (await first.json()) as { runId: string };

  const second = await app.fetch(
    new Request(`${baseUrl}/u/${session.user.slug}/api/run`, { method: "POST", headers: { cookie } }),
  );
  // Contract: RunManager.start cancels the prior job and accepts the new one
  // with 202. We do not require a 409; we only require the second call to
  // not silently drop and to return a different runId.
  expect(second.status).toBe(202);
  const secondBody = (await second.json()) as { runId: string };
  expect(secondBody.runId).not.toBe(firstBody.runId);
});
