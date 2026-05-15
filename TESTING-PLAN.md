# E2E Testing Plan — FRC Programming Training Simulator

## Context

The control plane has solid Bun-test coverage (~5,000 lines across 15 files in `apps/control/src/__tests__/`), the contracts package has schema validation tests, and `apps/web/src/lib/keyboard-mapping.test.ts` covers the one piece of pure frontend logic. Everything else on the web side (~50 React files, 9 custom hooks, the Zustand store, the Driver Station, the editor/scope iframes, the import dialog, the admin pages) has no automated test coverage. The integration boundaries — login → workspace → editor → run → telemetry → DS → gamepad — have never been exercised end-to-end by code.

The decision log encodes around 20 specific bugs and gotchas that were fixed by hand and have no regression net (e.g., recursive permissions fix `18ffcb0`, Gradle lock contention `766e957`, gamepad selection-loss-on-reset `cb9fea6`, enable-payload shape `d111f70`, Vite relative-base `066141e`, multi-tab DS sync 015, GLIBCXX/JNI 017, headless GUI removal 016, auto chooser stale 95f450d). Many of these would silently regress on a refactor and only surface in user testing.

Goal: a Playwright suite that (a) covers the user-visible product end to end, (b) regresses the known bugs from decision logs, and (c) is fast and hermetic enough to run on every PR in a future CI pipeline. The bulk runs against a mocked Docker runtime so it doesn't need a container daemon; a small `@docker` smoke tier covers what only real Docker can prove.

---

## Architecture

### Two-tier strategy

**Tier 1 — Mocked (default).** Most tests use `MockWorkspaceRuntimeProvider` (already exists in `apps/control/src/__tests__/helpers.ts`) injected into `createApp()` via the `WorkspaceRuntimeProvider` boundary (`apps/control/src/runtime.ts:65`). The provider is wired to two in-process fakes:

- **Fake openvscode-server** (HTTP + WS upgrade) — answers as the editor target so the proxy code path is exercised end-to-end without launching a real container.
- **Fake HALSim/NT4 bridge** (WS) — accepts the control-plane's persistent upstream connection and exposes test hooks to inspect/inject DS and NT4 frames.

This tier runs in <2 min total on a laptop, needs no Docker daemon, and is the default `bun run e2e` target.

**Tier 2 — Docker smoke (`@docker`-tagged).** A handful (~6) of slow, end-to-end tests that exercise the real `frc-code:v2` image — building, running Gradle, JNI loading, multi-workspace Gradle lock isolation, headless GUI removal in imported projects. Run via `bun run e2e:docker`; requires Docker daemon and the prebuilt image.

### Single server in tests (matches production topology, in-process)

In dev there are two processes (`bun run dev:control` + `bun run dev:web`). In production and in E2E the control plane serves the prebuilt web bundle from `webDistDir`. This avoids Vite-dev-only behavior and matches real deployment proxy/asset paths (catches things like the Vite `base: "./"` bug from `066141e`).

The control plane runs **in-process inside Playwright** rather than as an external `main.ts` subprocess. A Playwright fixture calls `createApp()` directly and starts a `Bun.serve` listener on a random port; the resulting `ControlApp` is exposed to tests so they can:
- seed and inspect the `MockWorkspaceRuntimeProvider`,
- call `app.auth.$context.test.*` for auth seeding,
- query `app.storage.db` for assertions,
- swap config (capacity cap, build timeout, allowlist) without round-tripping through admin HTTP routes.

No test-only HTTP routes, query-string admin tokens, or trust-boundary bypasses are added to production code. Everything test-specific lives behind the fixture and the `E2E_TEST=1` env flag inside `createAuth()`.

### Auth: Better Auth test-utils, gated by env

Add the `testUtils` plugin to `createAuth()` in `apps/control/src/auth/auth.ts` **only when `process.env.E2E_TEST === "1"`**. This exposes `(await auth.$context).test.{createUser, saveUser, getCookies, login}` — used by a Playwright fixture to seed users and plant signed session cookies on the browser context. No OAuth round trip, no provider mocks, no test-only HTTP routes leaked into prod.

**Setting the flag.** `E2E_TEST=1` is set in every E2E script (see "How to run" below) so it propagates to all Playwright workers. The fixture asserts at startup that `(await app.auth.$context).test` exists; if it's `undefined`, the fixture fails fast with a clear "did you forget E2E_TEST=1?" message so implementers can't quietly work around the trust boundary.

**Negative test.** Add one non-E2E test in `apps/control/src/__tests__/auth.test.ts` (or alongside) that confirms `testUtils` is **absent** when `E2E_TEST` is unset — this locks the production gating so a refactor can't accidentally leak test helpers into a non-test build.

The existing `login()` helper in `apps/control/src/__tests__/helpers.ts:408` does this manually today by writing rows into the `user`/`session` tables and HMAC-signing the token. Better Auth test-utils replaces that hand-rolled code with the supported API, then sets `role`/`slug` custom fields and calls `app.storage.ensureWorkspaceForUser()` so the workspace is provisioned.

### Port allocation and `baseURL` coupling

Better Auth's `baseURL` is configured at `createAuth()` time and is used for callback redirects, cookie domain/path scoping, and origin checks. If the Bun server binds a random port *after* auth is built, the configured `baseURL` and the actual server URL diverge, and tests will exercise the wrong origin (cookies silently rejected, redirects pointing nowhere).

The fixture must:
1. **Preallocate** a free loopback port before constructing the app (e.g., open a TCP listener with port `0`, read its assigned port, close it; or have `createApp()` accept `port: 0` and expose the bound port back).
2. Pass `baseUrl: http://127.0.0.1:<port>` into `createApp()` so Better Auth and any URL-builder helpers see the right origin.
3. Bind `Bun.serve` on that same port.
4. Use `app.storage.config.baseUrl` (not a synthetic `app.baseUrl`) as the Playwright fixture's `baseURL`.
5. Assert at fixture start that the bound server port equals `new URL(app.storage.config.baseUrl).port` — if they ever drift, fail loudly.

### WebSocket coverage philosophy

User-visible behavior + critical contract assertions. The fake HALSim records every frame it receives, so a test can:

1. Drive the UI (click Enable, hold a key, select an autonomous routine).
2. Assert the UI reflects expected state.
3. Assert the fake HALSim received the right payload shape (catches `d111f70`-style bugs that don't surface in the UI).

Frame-by-frame replay is not pursued — that's contracts-test territory.

---

## Directory layout

```text
e2e/                                  NEW — root-level Playwright suite
  playwright.config.ts
  global-setup.ts                     verify web bundle exists; one-time mkdir for traces
  fixtures/
    app.ts                            launches control plane in-process, returns ControlApp + URL
    auth.ts                           loginAs(page, app, {role, email, slug?}) via test-utils
    runtime.ts                        helpers for MockWorkspaceRuntimeProvider scenarios
    fake-vscode.ts                    Bun HTTP+WS server impersonating openvscode-server
    fake-halsim.ts                    Bun WS server with frame-recording + state injection
    projects/                         sample project trees used in import/build tests
      broken-build/                   compile error fixture
      headless-incompatible/          uses addGui() / addDriverstation()
      vendor-jni/                     vendor library requiring GLIBCXX 3.4.32+
  page-objects/
    login.po.ts
    workspace.po.ts                   editor pane, scope pane, run button, console
    driver-station.po.ts              enable/disable, mode, controller select, keyboard tile
    import.po.ts
    admin.po.ts                       users, capacity, audit log, allowlist
  specs/
    auth/
      login.spec.ts
      session-isolation.spec.ts
      allowlist.spec.ts
      roles.spec.ts
    workspace/
      open-workspace.spec.ts
      file-permissions.spec.ts
      session-persistence.spec.ts
    editor-proxy/
      iframe-load.spec.ts
      ws-proxy.spec.ts
      hop-by-hop-headers.spec.ts
      asset-base-path.spec.ts
    run/
      run-lifecycle.spec.ts
      build-failure.spec.ts
      build-timeout.spec.ts
      run-state-recovery.spec.ts
      concurrent-runs.spec.ts
    halsim/
      driver-station.spec.ts
      multi-tab-sync.spec.ts
      transient-unavailability.spec.ts
    gamepad/
      controller-selection-persistence.spec.ts
      controller-unplug-safety.spec.ts
      pre-run-no-lease.spec.ts
      keyboard-focus.spec.ts
      auto-chooser-stale.spec.ts
    import/
      github-import-happy.spec.ts
      import-size-limit.spec.ts
      import-rate-limit.spec.ts
      post-import-permissions.spec.ts
      backup-restore.spec.ts
    admin/
      capacity-cap.spec.ts
      audit-log.spec.ts
      user-management.spec.ts
      allowlist-management.spec.ts
    telemetry/
      ascope-iframe.spec.ts
      nt4-multi-workspace.spec.ts
    public/
      openapi-public.spec.ts
      health.spec.ts
    smoke-docker/                     @docker — opt-in, requires Docker daemon
      real-container-build-run.spec.ts
      vendor-jni-glibcxx.spec.ts
      gradle-lock-contention.spec.ts
      headless-gui-removal.spec.ts
      file-save-permissions.spec.ts
      extension-cache-seed.spec.ts
```

Unit tests in `apps/control/src/__tests__/`, `apps/web/src/lib/`, `packages/contracts/src/`, `scripts/`, `containers/code/` stay where they are and continue to run under `bun test`.

---

## Test infrastructure

### `e2e/fixtures/app.ts` — control plane fixture

Wraps the existing `withApp()` pattern from `helpers.ts` for the Playwright lifecycle. The fixture is **test-scoped**: each `test()` gets a fresh tempdir, fresh SQLite, fresh `MockWorkspaceRuntimeProvider`, and a fresh `Bun.serve` listener on a random port. Teardown closes the server and removes the tempdir. Spinning up per test is cheap (~50–100 ms) and trades a small startup cost for clean isolation, which matters wherever tests touch global-ish state (rate-limit counters in `imports.ts`, `RunManager` queues, etc.).

The fixture exposes:
- `app: ControlApp` — direct in-process access for seeding/inspection.
- `baseURL: string` — the random `http://127.0.0.1:<port>` for the worker.
- `runtime: MockWorkspaceRuntimeProvider` — for `seedRuntime()`, `simulateRuntimeFailure()`, etc.
- `auth: AuthTestUtils` — `(await app.auth.$context).test`.

Wires:
- `templateDir` → built from `templates/wpilib-java-command/` (or a minimal fixture template — same approach as `createTemplate()`).
- `webDistDir` → `apps/web/dist/` (built/rebuilt by `global-setup.ts`).
- `advantageScopeDistDir` → existing `vendor/AdvantageScope/dist-lite/` or a fixture stub.
- `runtimeProvider` → `MockWorkspaceRuntimeProvider` pre-seeded so `ensureWorkspaceRunning()` returns runtimes pointing at the fake-vscode and fake-halsim ports.

### `e2e/fixtures/auth.ts` — Better Auth test-utils helpers

```ts
export async function loginAs(
  page: Page,
  app: ControlApp,
  opts: { name: string; role?: "student" | "admin"; email?: string }
) {
  const ctx = await app.auth.$context;
  const testHelpers = ctx.test; // exposed only when E2E_TEST=1
  const email = opts.email ?? `${opts.name.toLowerCase()}@test.local`;
  const slug = slugFromEmail(email);
  const user = testHelpers.createUser({ email, name: opts.name });
  await testHelpers.saveUser(user);
  app.storage.db
    .query("UPDATE user SET role=?, slug=? WHERE id=?")
    .run(opts.role ?? "student", slug, user.id);
  await app.storage.ensureWorkspaceForUser(user.id, slug);
  const cookies = await testHelpers.getCookies({
    userId: user.id,
    domain: new URL(app.storage.config.baseUrl).hostname,
  });
  await page.context().addCookies(cookies);
  return { user, slug };
}
```

(Use `app.storage.config.baseUrl` — the auth-configured origin — not a synthetic `app.baseUrl`. If those two ever differ, cookie planting silently sends them to the wrong origin; see "Port allocation and `baseURL` coupling" above.)

**Scope.** `loginAs` is the fast shortcut for tests that *need* an authenticated session but aren't testing auth itself. It bypasses the OAuth callback handler, so it must **not** be used to validate the production sign-in path. **Auth-path tests** (T1.2, T3.1, T3.1b in the catalog) instead drive Better Auth's real callback handler — either through `test-utils`' provider-callback helper, or by POSTing a fabricated callback to `/api/auth/callback/<provider>` with the OAuth state and userinfo stubbed — so that `databaseHooks.user.create.before` (allowlist + slug) and the after-callback hook (workspace provisioning via `ensureWorkspace`) both fire.

### `e2e/fixtures/fake-vscode.ts`

Bun server listening on an ephemeral port:
- `GET /...` → 200, returns small HTML/JS that includes a sentinel string (e.g., `data-fake-vscode-ready`).
- WS upgrade on `/`, `/vscode/`, `/<slug>/vscode/` paths → records every received header on a queue, echoes any text frames sent.
- Exposes `getReceivedHeaders()` and `getReceivedFrames()` test hooks.

### `e2e/fixtures/fake-halsim.ts`

Bun WS server impersonating the HALSim bridge that the control plane connects to:
- Accepts upstream connection from control plane on a per-workspace port.
- Records every JSON frame received.
- Maintains in-memory authoritative state (enabled, mode, joystick frames, NT4 topics).
- Test hook to push frames upstream-to-cp (simulates robot state changes).
- For NT4 proxy tests: serves a minimal NT4 announcer that publishes a sentinel topic name when a workspace's run starts.

### `e2e/fixtures/runtime.ts`

Thin helpers around `MockWorkspaceRuntimeProvider`:
- `seedRuntime({ workspaceId, fakeVscodePort, fakeHalsimPort })` — sets `endpoints.vscode.{httpBaseUrl,wsBaseUrl,basePath}`, `endpoints.halsim.wsUrl`, `endpoints.nt4.wsUrl` to the fake servers.
- `simulateRuntimeFailure(workspaceId)` — flips state to `crashed`, drives run-state-recovery test.
- `injectGradleLockError(workspaceId)` — for build-failure variants.

### Page objects

Encapsulate selectors and high-level interactions. Example `workspace.po.ts`:

```ts
export class WorkspacePage {
  constructor(private page: Page, private slug: string) {}
  async goto() { await this.page.goto(`/u/${this.slug}/`); }
  editorIframe()    { return this.page.frameLocator("iframe[data-pane='editor']"); }
  scopeIframe()     { return this.page.frameLocator("iframe[data-pane='scope']"); }
  runButton()       { return this.page.getByTestId("run-button"); }
  stopButton()      { return this.page.getByTestId("stop-button"); }
  consoleOutput()   { return this.page.getByTestId("run-console"); }
  runStatus()       { return this.page.getByTestId("run-status"); } // "idle"|"building"|"running"|"failed"|"stopped"
  async startRun()  { await this.runButton().click(); }
  async waitForStatus(s: string) { await expect(this.runStatus()).toHaveText(s); }
}
```

Page objects also document needed `data-testid` attributes — the implementation phase will add any that don't exist yet.

### Test data conventions

- Default isolation: each `test()` gets a clean app via fixture scope. No global state.
- Determinism: time is controlled via `Date.now()` injection where the runbook timeouts matter (build-timeout, rate-limit, idle).
- Test attributes: prefer `data-testid` over text/CSS to insulate against copy/style churn.
- No hardcoded sleeps: use `expect().toPass()` / `expect.poll()` for async state.

---

## How to run (local-only for now)

Add to root `package.json`:

```json
"e2e": "E2E_TEST=1 playwright test --project=mocked",
"e2e:ui": "E2E_TEST=1 playwright test --project=mocked --ui",
"e2e:docker": "E2E_TEST=1 playwright test --project=docker-smoke",
"e2e:debug": "E2E_TEST=1 PWDEBUG=1 playwright test --project=mocked",
"e2e:report": "playwright show-report"
```

`E2E_TEST=1` is set at the script level so it propagates to every Playwright worker process. `createAuth()` reads this flag to install the `testUtils` plugin; the fixture asserts the plugin is present and fails fast if not, so the gating cannot silently be wrong.

The web bundle is built/refreshed automatically by Playwright's `globalSetup` (see config below), so there is no separate `build:web` step to forget. A stale bundle is structurally impossible under this scripts layout.

First-time setup:

```bash
bun install
bunx playwright install chromium
```

Day-to-day:

```bash
bun run e2e              # mocked tier; globalSetup rebuilds apps/web/dist first
bun run e2e specs/run/   # single suite
bun run e2e:ui           # Playwright UI mode for debugging
bun run e2e:docker       # @docker smoke tier; needs Docker + `bun run docker:build:code`
```

CI is out of scope for this plan; the mocked tier is designed to drop into a GitHub Actions job in a future phase by simply running `bun run e2e` on a stock `bun + chromium` image. The Docker tier needs a runner with the Docker socket.

---

## Playwright config (sketch)

```ts
import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e/specs",
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    // baseURL is per-test, supplied by the `app` fixture (random port per test).
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "mocked",
      testIgnore: /smoke-docker/,
      use: devices["Desktop Chrome"],
      timeout: 30_000,
    },
    {
      name: "docker-smoke",
      testMatch: /smoke-docker/,
      use: devices["Desktop Chrome"],
      timeout: 180_000,
      // T-D6 (Java/WPILib extension cold start, up to 5 min) overrides this
      // with `test.setTimeout(420_000)` at the top of its spec file.
    },
  ],
});
```

**No `webServer` block.** Each test's fixture calls `createApp()` + `Bun.serve` in-process and exposes `baseURL` via the fixture object. This is what enables direct access to the `ControlApp` instance, the mock runtime provider, and `app.auth.$context` from tests — none of which an external `main.ts` subprocess could provide without test-only HTTP routes that would weaken the trust boundary the suite is supposed to validate.

**`globalSetup` runs `bun run build:web`** (and fails the test run if the build fails), so `apps/web/dist/` is always up to date before tests run. Don't merely check that `dist/` exists — a stale bundle is the failure mode that defeats the whole point of covering the React shell.

The `E2E_TEST` flag is read by `createAuth()` to install the Better Auth `testUtils` plugin. The fixture passes the `MockWorkspaceRuntimeProvider` to `createApp()` directly as a constructor argument — no env-var injection, no admin endpoint, no query-string token.

---

## Test catalog — mocked tier

Each entry: file → test name → setup → steps → assertions → regression anchor.

### auth/login.spec.ts

**T1.1 `unauthenticated visit redirects to login`**
- Setup: fresh app.
- Steps: `page.goto("/")`.
- Assertions: URL ends at `/login` (or whatever the login route is); login page renders.

**T1.2 `OAuth callback creates workspace and routes to /u/<slug>/`** *(real auth path — does NOT use `loginAs`)*
- Setup: fresh app; OAuth provider stubbed so `/api/auth/callback/<provider>` accepts a fabricated callback (or use Better Auth `test-utils`' provider-callback helper if available).
- Steps: drive Better Auth's callback handler for a brand-new user `alice@allowed.test`; follow the redirect.
- Assertions: redirects to `/u/alice/`; DB has user + workspace + session rows; `data/users/<id>/project/` contains template files; both `databaseHooks.user.create.before` (slug + allowlist) and the after-callback hook (`ensureWorkspace`) actually fired — confirmed by their visible side effects (slug column populated, project dir created), so the test fails if either hook is removed.
- Anchor: decision 014, `auth.ts:75-118`.

**T1.3 `session survives page reload`**
- Setup: logged-in Alice.
- Steps: navigate to workspace, reload.
- Assertions: still authenticated; workspace UI visible.

**T1.4 `logout clears session and redirects to login`**
- Setup: logged-in Alice.
- Steps: click user-menu → Sign Out.
- Assertions: cookie cleared; `/u/alice/` returns 401/redirect.

### auth/session-isolation.spec.ts

**T2.1 `cross-workspace HTML access returns 403`**
- Setup: Alice + Bob each logged in via separate browser contexts.
- Steps: Alice's context fetches `/u/bob/`.
- Assertions: 403.
- Anchor: routing security (default-deny + `requireWorkspaceOwnership()`).

**T2.2 `cross-workspace /vscode/ proxy returns 403`**
- Same as above for `/u/bob/vscode/index.html`.
- Anchor: `apps/control/src/__tests__/proxy.test.ts` gap — not exercised through real cookies.

**T2.3 `cross-workspace WS upgrade rejected`**
- Steps: open `ws://.../u/bob/ws/run` with Alice's cookie.
- Assertions: connection closes immediately, no frames delivered.

### auth/allowlist.spec.ts

**T3.1 `allowlist blocks non-roster email (new user)`** *(real auth path)*
- Setup: allowlist seeded to `{*@allowed.test}`.
- Steps: drive Better Auth's callback handler for `evil@blocked.test`.
- Assertions: `APIError FORBIDDEN`; no `user`, `session`, or `workspaces` row created; no project dir created.
- Anchor: `auth.ts:80` `databaseHooks.user.create.before`.

**T3.1b `allowlist blocks returning user whose email was de-listed`** *(real auth path)*
- Setup: existing user `alice@allowed.test` with active session; then remove that pattern from the allowlist.
- Steps: drive a second OAuth callback for Alice.
- Assertions: the just-created session is revoked (per `auth.ts:101-108`); response is FORBIDDEN; pre-existing session also fails subsequent auth checks.
- Anchor: `auth.ts:97-117` after-callback hook.

**T3.2 `slug collision suffixes are unique`**
- Setup: pre-seed `user{slug=alice}`; then `loginAs(name:"Alice", email:"alice@other.test")`.
- Assertions: second user gets `alice1` or similar; both workspaces exist; both can log in independently.
- Anchor: workspace creation collision handling.

### auth/roles.spec.ts

**T4.1 `student cannot reach /admin/`**
- Setup: student Alice.
- Steps: `page.goto("/admin/")`.
- Assertions: 403 / redirect.

**T4.2 `admin can reach /admin/`**
- Setup: `loginAs(role:"admin")`.
- Steps: `page.goto("/admin/")`.
- Assertions: admin dashboard renders.

### workspace/open-workspace.spec.ts

**T5.1 `first login seeds template files into project dir`**
- Steps: login, open workspace, assert editor iframe loads, hit `/u/<slug>/api/files/...` (or check fs) for template files.
- Anchor: `scripts/template-integrity.test.ts`, template seeding.

**T5.2 `Starting... state shown while runtime provisions`**
- Setup: `MockWorkspaceRuntimeProvider` configured to delay `ensureWorkspaceRunning` by ~500ms.
- Steps: load workspace.
- Assertions: "Starting…" indicator visible; transitions to ready.

**T5.3 `runtime failure shows error UI`**
- Setup: mock provider set to throw on ensure.
- Assertions: error banner with retry; clicking Retry calls ensure again.

### workspace/file-permissions.spec.ts

Permissions are a Docker-tier concern in detail; the mocked counterpart asserts the UI surfaces save errors gracefully when the exec stream returns EACCES.

**T6.1 `save error surfaces in UI`** — mock exec returns EACCES on file write; UI shows toast.

### workspace/session-persistence.spec.ts

**T7.1 `reopening workspace reconnects to existing runtime`**
- Steps: open workspace, close tab, reopen.
- Assertions: no duplicate runtime; reuses lease.

### editor-proxy/iframe-load.spec.ts

**T8.1 `editor iframe renders content from /u/<slug>/vscode/`**
- Steps: open workspace, wait for iframe.
- Assertions: iframe URL matches `/u/<slug>/vscode/`; sentinel string from fake-vscode visible inside iframe.

### editor-proxy/ws-proxy.spec.ts

**T9.1 `editor WebSocket connects through proxy`**
- Steps: editor loads, triggers WS upgrade.
- Assertions: fake-vscode `getReceivedFrames()` shows at least one frame round-trip.

**T9.2 `editor WS reconnects cleanly after refresh`**
- Steps: open workspace, reload page.
- Assertions: a fresh WS connection arrives at fake-vscode; no protocol error in the page console.
- Anchor: commit `158bab4` hop-by-hop headers.

### editor-proxy/hop-by-hop-headers.spec.ts

**T10.1 `proxy strips hop-by-hop headers`**
- Steps: open editor, trigger WS upgrade.
- Assertions: fake-vscode receives request without `Connection`, `Transfer-Encoding`, `TE`, `Trailers`, etc., except those required for WS upgrade.
- Anchor: `158bab4`, `stripHopByHopHeaders()` in `apps/control/src/app.ts`.

### editor-proxy/asset-base-path.spec.ts

**T11.1 `web shell assets resolve under /u/<slug>/`**
- Steps: open workspace; capture all asset requests.
- Assertions: every `<script>`/`<link>` URL resolves under the workspace base path with no absolute `/assets/...` 404s.
- Anchor: commit `066141e` Vite relative base.

### run/run-lifecycle.spec.ts

**T12.1 `Run → build → running → stop`**
- Setup: mock run command factory streams a fixed build output then runtime output; exit 0.
- Steps: click Run; wait for build log lines in console; wait for status `running`; click Stop.
- Assertions: status transitions `idle → building → running → stopped`; console contains expected lines; fake HALSim receives a connection during `running`; disconnect on stop.

### run/build-failure.spec.ts

**T13.1 `build failure surfaces stderr and re-enables Run`**
- Setup: mock factory exits with code 1 and stderr containing "compilation failed".
- Assertions: status reaches `failed`; console shows stderr; Run button re-enabled.

### run/build-timeout.spec.ts

**T14.1 `build exceeding RUN_BUILD_TIMEOUT_MS is killed`**
- Setup: config `runBuildTimeoutMs: 500` **and** `simStartupTimeoutMs: 500` (the run manager arms a readiness timer separately from the build timer; with only `runBuildTimeoutMs` set, the readiness timer's 30 s default would dominate and the test would hit Playwright's 30 s project timeout before the build timeout fired — i.e., fail for the wrong reason). Mock factory never exits.
- Assertions: status reaches `failed` within ~600 ms with a build-timeout error explicitly identified (distinguishable from a sim-readiness-timeout error — match the error code or message that proves *which* timer fired); mock `kill()` was called.
- Anchor: runbook §9.

**T14.2 `sim readiness timeout fires when build completes but sim never reports ready`** *(complementary test)*
- Setup: `runBuildTimeoutMs: 5_000`, `simStartupTimeoutMs: 500`; mock factory exits 0 quickly but the fake HALSim never sends ready.
- Assertions: status reaches `failed` with a readiness-timeout error (the *other* error code from T14.1); mock `kill()` was called.
- Anchor: same as T14.1 — proves the two timers are independent.

A complementary Docker-tier check that a long-running `docker exec` is actually terminated when the timeout fires lives in **T-D7** (added to the Docker smoke catalog below).

### run/run-state-recovery.spec.ts

**T15.1 `external runtime crash updates UI to stopped`**
- Setup: start a run; while `running`, call `simulateRuntimeFailure()`.
- Assertions: UI reflects `stopped` (or `crashed`) within a few seconds; no stale `running`.
- Anchor: commit `4470c37`.

**T15.2 `stale running status cleared on app restart`**
- Setup: mark a workspace's run as `running` in DB; recreate the app.
- Assertions: status reconciled to `stopped` on app boot.

### run/concurrent-runs.spec.ts

**T16.1 `second Run while one is active is rejected or queued per contract`**
- Steps: click Run; before it stops, click Run again.
- Assertions: matches `RunManager` contract (likely 409 / single-active); UI surfaces the error or queue state.

### halsim/driver-station.spec.ts

**T17.1 `enable command payload reaches HALSim in correct shape`**
- Steps: login, run sim (mock returns ready), click Enable in DS.
- Assertions: fake HALSim's frame queue contains a frame matching `{ enabled: true, mode: "<initial>" }` (or whatever the contract says); UI shows `Enabled`.
- Anchor: commit `d111f70` — this exact bug was a wrong payload shape.

**T17.2 `disable returns robot to disabled and propagates`**
- Same as above with disable.

**T17.3 `mode switch (auto/teleop/test) propagates`**
- For each mode, assert fake HALSim received the expected payload and UI updated.

### halsim/multi-tab-sync.spec.ts

**T18.1 `two tabs of same workspace stay in sync`**
- Setup: same browser context, open `/u/alice/` in two pages.
- Steps: in page A, click Enable.
- Assertions: page B's DS reflects `Enabled` within a few seconds without page B reconnecting the HALSim WS (since the bridge is on the control plane).
- Anchor: decision 015.

### halsim/transient-unavailability.spec.ts

**T19.1 `HALSim restart doesn't spam errors`**
- Setup: bring fake HALSim down for ~500ms during a run.
- Assertions: UI shows "Waiting for HALSim" warning, NOT an error toast loop; no more than N error log entries; once HALSim returns, indicator returns to green.
- Anchor: commit `cb9fea6` silent-drop logic.

### gamepad/controller-selection-persistence.spec.ts

**T20.1 `controller selection survives Stop+Run`**
- Setup: load workspace, simulate gamepad connect (`navigator.getGamepads` shim), choose "Pad 1".
- Steps: click Run, then Stop, then Run again.
- Assertions: selection still "Pad 1" after each cycle; joystick indicator never goes yellow.
- Anchor: commit `cb9fea6`.

### gamepad/controller-unplug-safety.spec.ts

**T21.1 `unplug while enabled disables and sends neutral joystick`**
- Steps: enable robot; simulate gamepad disconnect.
- Assertions: fake HALSim receives a disable frame and a zero-joystick frame; UI shows disabled.
- Anchor: decision 018.

### gamepad/pre-run-no-lease.spec.ts

**T22.1 `gamepad input before Run does not produce no-lease errors`**
- Steps: connect gamepad, push sticks; without clicking Run, observe logs.
- Assertions: no error frames in the WS error log; no console errors in the page.
- Anchor: commit `cb9fea6`.

### gamepad/keyboard-focus.spec.ts

**T23.1 `keyboard input only flows while Keyboard tile has focus`**
- Steps: focus keyboard tile, hold `W`, blur to editor.
- Assertions: while focused, fake HALSim sees axis frames matching W; on blur, frames go neutral immediately.
- Anchor: decision 019.

### gamepad/auto-chooser-stale.spec.ts

**T24.1 `auto chooser refreshes after sim restart`**
- Setup: NT4 fake announces chooser with options A,B.
- Steps: select B; stop sim; restart sim and have NT4 announce options C,D (different program).
- Assertions: UI no longer shows B; shows fresh options.
- Anchor: commit `95f450d`.

### import/github-import-happy.spec.ts

**T25.1 `valid GitHub URL imports and files appear`**
- Setup: stub the GitHub fetch to return a known tarball fixture.
- Steps: open import dialog, paste URL, confirm.
- Assertions: progress stream emits expected stages; project dir contains expected files.

### import/post-import-permissions.spec.ts

**T28.1 `post-import file save works`** (mocked variant)
- Steps: import; immediately call exec to write a file via runtime; mock returns 0.
- Assertions: no EACCES surfaces. (Real coverage is in Docker-tier T-D5.)
- Anchor: commit `18ffcb0`.

### import/backup-restore.spec.ts

**T29.1 `restore from backup overwrites project`**
- Steps: create workspace, create backup, modify file, restore backup.
- Assertions: file content matches pre-modification snapshot; audit log entry.

### admin/capacity-cap.spec.ts

**T30.1 `cap=2 with 3 simultaneous workspaces returns 503`**
- Setup: config `maxActiveContainers: 2`; loginAs three users; open each workspace.
- Assertions: third receives 503 with capacity message.
- Anchor: hardening plan §A, `apps/control/src/__tests__/capacity.test.ts` lacks UI coverage.

**T30.2 `admin can raise cap at runtime and third retry succeeds`**
- Steps: as admin, POST `/admin/config/max-active-containers` with value 3; third user retries.
- Assertions: third workspace opens; audit log records the cap change.

### admin/audit-log.spec.ts

**T31.1 `admin actions appear in audit log`**
- Steps: promote a user, change cap, restore a backup, delete a user.
- Assertions: audit log UI shows four entries with correct actor/action/target.

**T31.2 `audit log filter and pagination`**
- Steps: seed many entries; filter by actor and action.
- Assertions: results match filter; pagination buttons advance.

### admin/user-management.spec.ts

**T32.1 `cannot demote last admin`**
- Setup: single admin.
- Steps: attempt self-demote.
- Assertions: rejected with explanatory error.

**T32.2 `delete user removes workspace`**
- Steps: as admin, delete student.
- Assertions: project dir removed; runtime stopped/removed via mock provider.

### admin/allowlist-management.spec.ts

**T33.1 `admin adds allowlist entry → new user can log in`** *(real auth path for the student)*
- Setup: empty allowlist. Use `loginAs` to authenticate as the admin actor only — that's a product-flow helper, fine for the admin side.
- Steps:
  (a) drive Better Auth callback for `newkid@allowed.test` → expect FORBIDDEN with no user/session/workspace row;
  (b) admin POSTs `*@allowed.test` to `/admin/allowlist`;
  (c) drive a second OAuth callback for `newkid@allowed.test`.
- Assertions: (a) initial callback returns FORBIDDEN and DB has no rows for that email; (b) admin POST 200 and audit-log entry recorded; (c) second callback creates user + session + workspace + project dir, redirects to `/u/newkid/`.
- Anchor: `auth.ts:80` create-hook + `auth.ts:97-117` after-callback hook. `loginAs` cannot be used for the student side here — it bypasses both hooks and would let the test pass even if roster enforcement were broken.

### telemetry/ascope-iframe.spec.ts

**T34.1 `AdvantageScope iframe loads under workspace base path`**
- Steps: open workspace, wait for scope iframe.
- Assertions: iframe loaded; NT4 WS via control-plane proxy reaches fake HALSim/NT4 (frame queue has the topic-subscribe request).

### telemetry/nt4-multi-workspace.spec.ts

**T35.1 `two workspaces' NT4 traffic isolated`**
- Setup: two users, each runs sim; their fake HALSim instances receive only their own topics.
- Steps: in user A's run, inject topic `Robot/A`; in user B's run, inject topic `Robot/B`.
- Assertions: each user's scope sees only their topic.
- Anchor: decision 013, port ranges in decision 015.

### public/openapi-public.spec.ts

**T36.1 `GET /api/openapi.json works without auth and is workspace-agnostic`**
- Steps: fetch with no cookies.
- Assertions: 200, JSON contains paths, no workspace IDs/emails in payload.
- Anchor: decision 015.

### public/health.spec.ts

**T37.1 `healthz returns 200 unauthenticated`**
- Used by Playwright `webServer.url` already; T37.1 just locks the contract.

---

## Test catalog — Docker smoke tier (`@docker`-tagged)

Each requires `bun run docker:build:code` first and a running Docker daemon. Default per-test timeout is 180 s (set on the `docker-smoke` Playwright project). Slow tests override per-spec with `test.setTimeout(ms)` — noted explicitly below where needed.

**T-D1 `real container starts, editor loads, file save succeeds`** — login, wait for real openvscode iframe to render full VS Code UI; create a file via the editor; assert no EACCES (anchor: `18ffcb0`).

**T-D2 `import vendor-jni fixture builds and runs sim`** — uses `e2e/fixtures/projects/vendor-jni/`; assert no `GLIBCXX_3.4.32 not found` error (anchor: decision 017).

**T-D3 `two workspaces' sims run concurrently without Gradle lock contention`** — login two users, start two sims; assert both reach `running` and neither logs `LockTimeoutException` (anchor: `766e957`).

**T-D4 `import headless-incompatible fixture starts headless`** — fixture's project uses `wpi.sim.addGui()`; assert init.gradle stripped GLFW deps and HALSim WS is reachable (anchor: decision 016).

**T-D5 `post-import file save succeeds (recursive chown verified end-to-end)`** — import the vendor-jni fixture; in the editor, save a new file under `src/`; assert no permission error (anchor: `18ffcb0`).

**T-D6 `editor cold start activates Java and WPILib extensions`** — assert "Java is ready" status within 5 min; F12 on `frc.robot.Robot` opens source. **Per-test timeout: 420 s** (`test.setTimeout(420_000)` at the top of the spec). The project default of 180 s is too tight for this one. Anchor: decisions 011, 012, 017.

**T-D7 `real long-running docker exec is killed when build timeout fires`** — set `runBuildTimeoutMs: 3_000` and import a tiny project whose Gradle build is artificially slowed (e.g., a fixture project with a `Thread.sleep(60_000)` in its build script, or an init script that adds one). Assert that within ~4 s the run is marked `failed` and `docker exec` for that workspace is no longer running (verify via `docker ps` or by attempting another exec). Per-test timeout: 60 s. This is the Docker-tier counterpart to T14.1 — proves the timer actually reaches across the runtime boundary, not just kills an in-process mock. Anchor: runbook §9.

---

## Critical files / surfaces to touch

- `apps/control/src/auth/auth.ts` — add `testUtils` plugin behind `process.env.E2E_TEST === "1"`.
- `apps/control/src/app.ts` — `createApp()` is already programmatically usable; the Playwright fixture imports it directly and passes the `MockWorkspaceRuntimeProvider` as a constructor argument. `main.ts` requires no changes; no test-only env vars, HTTP routes, or query-string tokens are added to production code.
- `apps/control/src/__tests__/helpers.ts` — reuse `createTemplate`, `createWebDist`, `createAdvantageScopeDist`, `MockWorkspaceRuntimeProvider`; promote those helpers' interfaces so they can be imported by `e2e/fixtures/` (currently colocated with Bun tests; move pure-helpers into `apps/control/src/testing/` and re-export from there to avoid coupling unit tests to E2E).
- `apps/web/src/components/*` — add `data-testid` attributes for: run button, stop button, run console, run status, editor iframe, scope iframe, driver-station enable/disable/mode, controller select, keyboard tile, admin tables, audit log.
- Root `package.json` — add Playwright deps and scripts; `bunx playwright install chromium` is a one-time dev step (documented in runbook).
- `docs/runbook.md` — add an "Running E2E tests" section.

Existing utilities that should be **reused, not reinvented**:
- `MockWorkspaceRuntimeProvider` (`helpers.ts:272`).
- `createFakeDocker` (`helpers.ts:143`) — informs fake-vscode/fake-halsim shape, not directly used.
- `createTemplate`/`createWebDist`/`createAdvantageScopeDist` (`helpers.ts:27`–`67`).
- `app.storage.ensureWorkspaceForUser` for workspace provisioning.
- `slugFromEmail` (`auth.ts:18`).

---

## Verification

After implementation, the following should all pass on a clean checkout:

1. `bun install && bunx playwright install chromium` succeeds.
2. `bun run typecheck` passes.
3. `bun run test` (existing Bun tests) still pass with no regressions.
4. `bun run build:web` produces `apps/web/dist/index.html`.
5. `bun run e2e` runs the mocked tier to completion in under ~3 min on a developer laptop, with all tests passing.
6. `bun run e2e:report` opens the HTML report with traces for any failure.
7. With the Docker daemon running and `bun run docker:build:code` complete, `bun run e2e:docker` passes all six smoke tests within ~10 min.
8. Inducing each regression manually (e.g., revert commit `cb9fea6`) makes the corresponding test fail with a clear diff.

---

## Companion test layers (beyond E2E)

The Playwright suite above is the integration tier. Three companion layers — frontend component tests, targeted security tests, and property/fuzz tests — fill gaps E2E can't cover efficiently and run in milliseconds rather than seconds. Each is small (one to a few days to seed) and reuses infrastructure that's already in place or nearly so.

### Frontend unit and component tests

**Why.** E2E catches what users see but is slow and doesn't isolate which component broke. Hooks like `useRunChannel`, `useGamepad`, and `useSimulationState` encode non-trivial state machines (reconnection, debouncing, joystick-indicator color computation) that should be tested in isolation.

**Where.** Co-locate with source, following the precedent set by `apps/web/src/lib/keyboard-mapping.test.ts`:
```text
apps/web/src/hooks/useRunChannel.test.ts
apps/web/src/hooks/useGamepad.test.ts
apps/web/src/components/DriverStation/EnableButton.test.tsx
...
```

**Tools.**
- **Vitest** as the runner — `apps/web` is already Vite-based, so Vitest reuses the Vite config and JSX/TS handling. Add `vitest`, `@vitest/coverage-v8`, `jsdom` to `apps/web` devDependencies.
- **React Testing Library** (`@testing-library/react`, `@testing-library/jest-dom`) for components.
- **MSW** (`msw`) for mocking REST and WebSocket endpoints in hook tests.
- Script: add `"test": "vitest"` to `apps/web/package.json`.

**Targets and tests.**

*Hooks (highest payoff):*
- **`useRunChannel`** — opens WS to `/u/<slug>/ws/run`, applies messages to a state machine, cleans up on unmount. Tests: mocked WS sends `building → running → stopped` sequences; assert state transitions, no leaked listeners after unmount, reconnect within debounce window.
- **`useGamepad`** — polls `navigator.getGamepads()`; emits frames; handles connect/disconnect. Tests: shim the gamepad API; assert frame cadence and shape; assert disconnect produces a zero-joystick frame (anchor: decision 018).
- **`useSimulationState`** — aggregates sim status + HALSim availability + gamepad state into the indicator color. Test the truth table.
- **`useContainerStatus`** — polling and backoff; 503 capacity response surfaces correct UI signal.
- **`useSession`** — 401 clears local session and redirects; logout calls the right endpoint.
- **`useAutoChoosers`** — refresh-on-restart logic (anchor: commit `95f450d`).

*Components:*
- **Run button** — state machine over `idle | building | running | failed | stopped`; disabled per state; debounced clicks don't double-dispatch.
- **DriverStation enable button** — disabled when sim isn't running; correct payload shape on click (anchor: commit `d111f70`).
- **Keyboard tile** — focus gating: events captured only while focused; blur clears keys to neutral (anchor: decision 019).
- **Import dialog** — client-side URL validation matches server-side contract.
- **Error boundary** — catches render errors and shows fallback without crashing the shell.

*Store (Zustand):*
- Input-mode transitions, theme persistence, gamepad selection persistence across run cycles.

*Pure utils:*
- `gamepad-mapping.ts`, `auth-client.ts`, `lib/utils.ts`.

**How to run.**
```bash
bun run --cwd apps/web test            # watch mode
bun run --cwd apps/web test --run      # single CI-style run
bun run --cwd apps/web test --coverage # coverage report
```

---

### Security tests

**Why.** Existing tests cover happy-path auth and admin permission boundaries; they don't probe input boundaries where hostile or malformed input could trigger SSRF, path traversal, command injection, or XSS. These bug classes bite even careful codebases.

**Where.**
- Unit-level (parser/validation): `apps/control/src/__tests__/security/`.
- Browser-level (XSS, CSP, cookie flags): `e2e/specs/security/`.

**Targets and tests.**

*SSRF in project import* (`apps/control/src/imports.ts`):
- **S1** Reject `http://localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, link-local `169.254.0.0/16` (cloud metadata at `169.254.169.254` especially), and internal-looking hostnames.
- **S2** Reject non-`https://github.com` URLs (protocol + host allowlist).
- **S3** Reject URL-confusion bypasses: `https://github.com@evil.com/`, `https://github.com.evil.com/`, IDN homographs (`gіthub.com` with Cyrillic і), trailing whitespace, embedded null bytes.
- **S4** DNS rebinding: re-validate the resolved IP at fetch time, not just at submit time.

*Path traversal:*
- **S5** Import target path: `..` segments in branch/subdir parameters must not escape the workspace project dir.
- **S6** File API paths: any read/write rejects `..` segments, absolute paths, and symlinks pointing outside the project.
- **S7** Backup/restore paths: restore-from-backup rejects paths outside `data/backups/`.
- **S8** Slug → directory mapping: a maliciously crafted slug must not write outside `data/users/`.

*Command injection:*
- **S9** Run command construction passes args as arrays to the runtime exec, never concatenated strings. Test by injecting `; rm -rf` style content in any user-influenced field.
- **S10** Docker labels containing user-influenced strings (workspace ID, email) are quoted/escaped. Test with embedded `"`, `\`, newlines.
- **S11** Git clone target paths are never interpolated into a shell string.

*Authentication / session:*
- **S12** Tampered cookie (changed HMAC, swapped `userId`) rejected.
- **S13** Replayed expired session token rejected after server-side TTL.
- **S14** Every `/admin/*` route requires admin role, not just an authenticated session — table-driven test enumerating all admin routes.
- **S15** Break-glass `ADMIN_TOKEN` header requires the configured secret and is logged in the audit log.

*XSS / output encoding (Playwright):*
- **S16** Sign in with display name `<img src=x onerror=alert(1)>`; verify no execution in topbar, admin user list, or audit log.
- **S17** Gradle build error containing `"><svg onload=alert(1)>` is rendered as text in the run console, not HTML.
- **S18** Audit log entries with crafted metadata render as text.

*Response headers (Playwright):*
- **S19** `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` (in prod), `Referrer-Policy` set on protected routes.
- **S20** Session cookie carries `HttpOnly`, `SameSite=Lax` (or stricter), and `Secure` flag in production config.

*CSRF:*
- **S21** State-changing endpoints (`POST /u/<slug>/api/run`, `PATCH .../driver-station`, admin actions) reject cross-origin POSTs without proper SameSite cookie scope.

*Rate limiting (extending existing coverage):*
- **S22** Login attempts are rate-limited (verify better-auth's protection is enabled and effective).

**How to run.**
```bash
bun test apps/control/src/__tests__/security      # unit-level
bun run e2e specs/security                        # browser-level
```

---

### Property and fuzz tests

**Why.** Parsers and validators have far more edge cases than handwritten tests can enumerate. Property-based tests generate hundreds of random inputs per run and shrink failing cases to minimal reproducers. The codebase already has one class of bug in this territory (slug collisions); the URL/import parsers and frame validators are likely hiding more.

**Where.** Co-locate under `apps/control/src/__tests__/property/` and `packages/contracts/src/__tests__/property/`.

**Tools.**
- **`fast-check`** — the de-facto TS property-testing library. Adds one dependency; integrates cleanly with `bun:test` via `fc.assert(fc.property(...))`.

**Targets and tests.**

*URL validation* (`apps/control/src/imports.ts`):
- **P1** For any string input, the validator either returns a normalized URL or rejects with a typed error. Never throws, never crashes. (The most important property — the "no surprises" guarantee.)
- **P2** Any accepted URL re-validates to the same accepted form (idempotence).
- **P3** Any URL containing `..`, `\0`, control chars, or a non-HTTPS scheme is rejected.

*Slug generation* (`apps/control/src/auth/auth.ts:18`):
- **P4** `slugFromEmail` output always matches `/^[a-z0-9][a-z0-9_-]{0,39}$/` for any RFC-5322-valid email, including Unicode names.
- **P5** Output is never empty (falls back to the `"student"` sentinel).
- **P6** Collision suffix algorithm: for any set of N emails sharing a slug prefix, all generated slugs are unique and ≤40 chars.

*Keyboard mapping* (`apps/web/src/lib/keyboard-mapping.ts`):
- **P7** For any set of pressed keys, all axis values are in `[-1.0, 1.0]` and button values are boolean.
- **P8** No key combination produces `NaN` or `Infinity`.

*Contract schemas* (`packages/contracts/src/`):
- **P9** Round-trip: any object that passes `schema.parse()` re-passes after `JSON.parse(JSON.stringify(...))`.
- **P10** Reject malformed inputs at every schema (workspace slug regex, run message tags, gamepad axis bounds).

*Audit log filter construction* (`apps/control/src/audit.ts`):
- **P11** Any combination of filter parameters produces parameterized SQL — no value flows into a concatenated query fragment.

*HALSim/NT4 frame parsing* (`apps/control/src/halsim.ts`, NT4 utils):
- **P12** For any byte sequence, the frame parser either returns a typed frame or a typed error. Never throws.

**How to run.**
```bash
bun test apps/control/src/__tests__/property       # ~5 sec, 100 cases per property
FAST_CHECK_NUM_RUNS=1000 bun test ...              # extended run for confidence
```

---

### Sequencing recommendation

**Phase 0 — Companion unit layers (~1 week, before E2E).** Property tests and security parser-level tests use the existing Bun runner and need no new infrastructure. They strengthen the unit test base immediately and surface real parser bugs before the larger E2E machinery is built. Catching those bugs at the unit level is cheaper than chasing them through E2E later.

**Phase 1 — E2E mocked tier + frontend unit tests in parallel.** They touch different layers and don't conflict; parallel tracks compress the timeline. One coordination rule: whoever adds `data-testid` attributes to a component should also write the Vitest test for that component in the same change, so each component is touched once.

**Phase 2 — E2E Docker smoke tier + security E2E tests (XSS, headers, CSRF).** Both build on Phase 1 infrastructure; saving them keeps Phase 1 focused on getting a green mocked tier into the developer workflow first.

This ordering also produces a CI-ready unit + integration suite at the end of Phase 1, with the Docker tier and security browser tests as opt-in additions on top.

---

## Open implementation choices (deliberately deferred)

- **Mock-provider seeding API** — exact shape of `seedRuntime()`. With the in-process fixture, this is just a TypeScript method on the `MockWorkspaceRuntimeProvider` instance the fixture exposes; nothing needs to cross a process boundary. Pick the method signature during implementation.
- **Gamepad simulation** — Playwright doesn't have first-class gamepad APIs; will use a small browser shim injected via `addInitScript` that overrides `navigator.getGamepads`.
- **NT4 fake fidelity** — the minimum protocol surface needed by the AS Lite client and the auto-chooser code. Start with the smallest subset, grow as tests fail.
- **Time control for rate limits and timeouts** — inject a clock into `runBuildTimeoutMs` and the rate-limit module, or use real timeouts with reduced values. Probably a clock injection.
