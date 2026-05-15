import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    // Per-test baseURL is supplied by the `app` fixture (random port per test).
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "mocked",
      testIgnore: [/smoke-docker/, /security\//],
      use: devices["Desktop Chrome"],
      timeout: 30_000,
    },
    {
      name: "security",
      testMatch: /security\//,
      use: devices["Desktop Chrome"],
      timeout: 30_000,
    },
    {
      name: "docker-smoke",
      testMatch: /smoke-docker/,
      use: devices["Desktop Chrome"],
      timeout: 180_000,
    },
  ],
});
