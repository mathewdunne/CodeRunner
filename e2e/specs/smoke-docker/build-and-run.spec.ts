/**
 * Vendor-jni fixture builds and runs the sim (decision 017).
 * Two workspaces run concurrently without Gradle lock contention (commit 766e957).
 * Headless-incompatible fixture starts headless (decision 016).
 * Long-running docker exec is killed when build timeout fires (runbook §9).
 */
import { test } from "@playwright/test";

test.skip(
  process.env.DOCKER_E2E !== "1",
  "Set DOCKER_E2E=1 and have Docker + frc-code:v2 to run docker-smoke tests",
);

test("vendor-jni fixture builds and runs without GLIBCXX error", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands. See README.md in this folder.");
});

test("two workspaces run concurrently — no Gradle LockTimeoutException", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});

test("headless-incompatible fixture (uses addGui) starts headless", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});

test("build timeout kills docker exec process", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});
