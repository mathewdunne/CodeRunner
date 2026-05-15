/**
 * T13.1, T14.1, T14.2, T15.x, T16.x — run-state edge cases.
 *
 * These all require: (a) a `runCommandFactory` injected into `createApp` that
 * lets the test script exit codes / stall, and (b) data-testids on the run
 * console and run status pill. We sketch the fixmes here so the catalog isn't
 * lost during the next iteration.
 */
import { test } from "@playwright/test";

test("T13.1 build failure surfaces stderr and re-enables Run", async () => {
  test.fixme(true, "Needs runCommandFactory + run-status testid.");
});

test("T14.1 build timeout kills the run", async () => {
  test.fixme(true, "Needs runCommandFactory that never exits + runBuildTimeoutMs override.");
});

test("T14.2 sim readiness timeout fires separately", async () => {
  test.fixme(true, "Needs runCommandFactory + simStartupTimeoutMs override + halsim never ready.");
});

test("T15.1 external runtime crash updates UI to stopped", async () => {
  test.fixme(true, "Needs MockWorkspaceRuntimeProvider.simulateRuntimeFailure() helper.");
});

test("T15.2 stale running status cleared on app restart", async () => {
  test.fixme(true, "Needs in-test re-creation of ControlApp with same DB.");
});

test("T16.1 second Run while one is active is rejected/queued per RunManager contract", async () => {
  test.fixme(true, "Needs run-button testid + runCommandFactory.");
});
