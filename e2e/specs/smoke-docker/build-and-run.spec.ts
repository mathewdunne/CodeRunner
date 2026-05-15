/**
 * T-D2 — vendor-jni fixture builds and runs the sim (decision 017).
 * T-D3 — two workspaces run concurrently without Gradle lock contention (commit 766e957).
 * T-D4 — headless-incompatible fixture starts headless (decision 016).
 * T-D7 — long-running docker exec is killed when build timeout fires (runbook §9).
 */
import { test } from "@playwright/test";

test.skip(
  process.env.DOCKER_E2E !== "1",
  "Set DOCKER_E2E=1 and have Docker + frc-code:v2 to run docker-smoke tests",
);

test("T-D2 vendor-jni fixture builds and runs without GLIBCXX error", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands. See README.md in this folder.");
});

test("T-D3 two workspaces run concurrently — no Gradle LockTimeoutException", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});

test("T-D4 headless-incompatible fixture (uses addGui) starts headless", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});

test("T-D7 build timeout kills docker exec process", async () => {
  test.fixme(true, "Implement when Docker E2E lane lands.");
});
