/**
 * Playwright test fixture: starts the control plane in-process, serves on a
 * random port, and tears everything down per test.
 *
 * Each `test()` gets:
 *  - `app`: the in-process ControlApp instance (for direct seeding/inspection)
 *  - `baseURL`: http://127.0.0.1:<port>
 *  - `runtime`: the MockWorkspaceRuntimeProvider
 *  - `fakeVscode`, `fakeHalsim`: fixture handles for assertions
 */
import { test as base } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { createApp, type ControlApp } from "../../apps/control/src/app";
import {
  MockWorkspaceRuntimeProvider,
  createTemplate,
  createAdvantageScopeDist,
} from "../../apps/control/src/__tests__/helpers";
import { startFakeVscode } from "./fake-vscode";
import { startFakeHalsim } from "./fake-halsim";
import type { FakeHalsimHandle, FakeVscodeHandle } from "./types";

export type AppFixtures = {
  app: ControlApp;
  baseURL: string;
  runtime: MockWorkspaceRuntimeProvider;
  fakeVscode: FakeVscodeHandle & { pushFrame?: never };
  fakeHalsim: FakeHalsimHandle & { pushFrame: (f: unknown) => void; connections(): number };
  appServer: { stop(): void };
};

async function preallocatePort(): Promise<number> {
  // Bun.serve with port: 0 hands back a free port; we open a throwaway server,
  // capture .port, then close it. This is racy in theory but Bun reuses the
  // OS-given port atomically.
  const tmp = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = (tmp as unknown as { port: number }).port;
  tmp.stop(true);
  return port;
}

export const test = base.extend<AppFixtures>({
  // eslint-disable-next-line no-empty-pattern
  fakeVscode: async ({}, use) => {
    const handle = await startFakeVscode();
    await use(handle as never);
    await handle.stop();
  },

  // eslint-disable-next-line no-empty-pattern
  fakeHalsim: async ({}, use) => {
    const handle = await startFakeHalsim();
    await use(handle);
    await handle.stop();
  },

  app: async ({ fakeVscode, fakeHalsim }, use) => {
    const root = await mkdtemp(join(tmpdir(), "frc-e2e-"));
    const templateDir = await createTemplate(root);
    const ascopeDistDir = await createAdvantageScopeDist(root);
    const webDistDir = resolve(__dirname, "../../apps/web/dist");

    const port = await preallocatePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    const runtime = new MockWorkspaceRuntimeProvider();

    const app = await createApp({
      dataDir: join(root, "data"),
      templateDir,
      webDistDir,
      advantageScopeDistDir: ascopeDistDir,
      sessionSecret: "e2e-session-secret",
      baseUrl,
      idleStopMinutes: 30,
      containerAutoStart: false,
      runtimeProvider: runtime,
    });

    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: (req, srv) => app.fetch(req, srv as never),
      websocket: app.websocket as never,
    });

    // Stash fakes for runtime.ts helpers
    (app as unknown as { __e2e: unknown }).__e2e = { fakeVscode, fakeHalsim };

    try {
      await use(app);
    } finally {
      server.stop(true);
      app.close();
      await rm(root, { recursive: true, force: true });
    }
  },

  baseURL: async ({ app }, use) => {
    await use(app.storage.config.baseUrl);
  },

  runtime: async ({ app }, use) => {
    await use(app.runtime as MockWorkspaceRuntimeProvider);
  },

  // Hooks for tests that want to control the lifecycle directly; not used
  // by most specs but available for the rare case where in-test re-start is
  // necessary (e.g. T15.2 "stale running status cleared on app restart").
  appServer: async ({ app }, use) => {
    await use({ stop: () => app.close() });
  },
});

export { expect } from "@playwright/test";
