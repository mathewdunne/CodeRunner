/**
 * Real `frc-code:v2` container starts, editor loads, file save succeeds.
 *
 * Requires:
 *   - Docker daemon running
 *   - `bun run docker:build:code` has been executed
 *   - `DOCKER_E2E=1` set in env (this is what the `bun run e2e:docker` script does)
 *
 * The mocked tier covers the same flow with a fake openvscode-server; this
 * spec is the one that proves the real image works.
 */
import { test } from "@playwright/test";

test.skip(
  process.env.DOCKER_E2E !== "1",
  "Set DOCKER_E2E=1 and have Docker + frc-code:v2 to run docker-smoke tests",
);

test("real container — editor iframe loads VS Code UI, file save succeeds", async ({
  page,
}) => {
  test.fixme(
    true,
    "Real-container coverage requires a fixture that spawns the LocalDockerRuntimeProvider " +
      "in-process, plus per-test workspace teardown. Implement when Docker E2E lane is " +
      "wired into CI. See e2e/specs/smoke-docker/README.md.",
  );
  // Sketch of intended flow:
  //   1. Build/reuse frc-code:v2
  //   2. Start a real workspace via the LocalDockerRuntimeProvider
  //   3. page.goto("/u/<slug>/")
  //   4. Wait for "Java is ready" status (~5 min cold start budget — anchor decision 011)
  //   5. Use the editor to write a new file under src/
  //   6. Assert no EACCES (anchor commit 18ffcb0)
  void page;
});
