# Decision 021: Testing suite implementation — deviations from TESTING-PLAN.md

**Date:** 2026-05-15
**Status:** Accepted
**Context:** `TESTING-PLAN.md` proposed a three-phase test suite (property + security unit tests, E2E mocked + frontend unit tests, Docker smoke + security browser tests). The plan was AI-drafted and reviewed; while implementing it, a handful of details warranted deviation. This log captures those decisions so future work doesn't reintroduce them by reading the plan and assuming it was followed verbatim.

## Summary

The suite was implemented end-to-end across all three phases, but with four deliberate departures from the plan:

1. **Better Auth `testUtils` plugin not adopted.** E2E auth seeding uses the existing direct-DB approach from `apps/control/src/__tests__/helpers.ts:login()` instead.
2. **No `E2E_TEST` env gating in production `createAuth`.** Follows from (1).
3. **Browser-heavy E2E specs that depend on missing `data-testid` attributes are marked `test.fixme(...)`** instead of being deleted or silently failing.
4. **Most regression coverage flows through the control plane's HTTP surface, not the React UI.** Spec mix is HTTP-driven where the regression is server-side, browser-driven only where the bug class needs a DOM.

## 1. Why not Better Auth `testUtils`

The plan's auth-seeding fixture assumes Better Auth exposes a `testUtils` plugin via `(await auth.$context).test.{createUser, saveUser, getCookies, login}`. That API was not verified to exist in the pinned `better-auth@^1.6.10`, and the plan itself called out a fallback risk ("if the plugin is `undefined`, the fixture fails fast").

Meanwhile, `helpers.ts:login()` already does exactly what the testUtils plugin would do: write to the `user` and `session` tables, HMAC-sign the session token with `app.storage.config.sessionSecret`, and return a Set-Cookie header. That code has been stable since the V2-2 phase, exercises the *real* cookie format the production middleware expects, and has no dependency on Better Auth's internal API surface.

The E2E `loginAs` helper in `e2e/fixtures/auth.ts` reuses that exact algorithm. Trade-off: the helper duplicates ~30 lines (the HMAC-sign + random-token logic) so we don't have a cross-cutting import from `apps/control/src/__tests__` into the `e2e/` tree. If those two ever diverge they will fail together — both produce the same cookie format and both go through `app.storage.ensureWorkspaceForUser`.

**Consequence:** the production trust boundary in `apps/control/src/auth/auth.ts` stays exactly as it was. No `process.env.E2E_TEST === "1"` branch, no dynamic-import test-helpers, no negative test required to "lock the production gating" (because there's nothing to gate). The fixture itself documents the bypass shape.

## 2. Auth-callback path tests are deferred

The plan called for "real auth path" tests (T1.2, T3.1, T3.1b, T33.1) that drive Better Auth's `/api/auth/callback/<provider>` handler with a fabricated OAuth response to validate `databaseHooks.user.create.before` (allowlist + slug) and the after-callback hook (workspace provisioning).

These are valuable but require either:
- a working `testUtils.signInWithProvider()` helper (see (1)), or
- a hand-rolled mock OAuth-provider server that the control plane's social-providers config points at.

Neither was built in this pass. Instead, the allowlist gate (`isEmailAllowed`) is covered at unit level in `e2e/specs/auth/allowlist.spec.ts` and the original `apps/control/src/__tests__/auth.test.ts`; the workspace-creation side-effect is covered by `loginAs` calling `ensureWorkspaceForUser` directly. If either hook breaks under refactor, the unit + workspace-creation tests still fail.

**Future work:** stand up a fake OAuth provider in `e2e/fixtures/oauth.ts` and write a `oauth-callback.spec.ts` that exercises the full callback path. See plan §"auth/login.spec.ts" T1.2 for the intended assertions.

## 3. Browser-heavy specs use `test.fixme`, not deletion

Many catalog entries (T9.x WS proxy, T12–T16 run lifecycle, T17–T19 driver-station UI, T20–T24 gamepad, T34 ASCope iframe) require `data-testid` attributes on components that don't exist yet (run button, run-status pill, DS enable/disable, keyboard tile, controller select, audit-log table). Two options:

- **Delete the specs** until the testids land.
- **Stub them with `test.fixme(true, "...")`**, including a one-line note saying what's needed.

We chose the second. `test.fixme` is *visible* in Playwright reports as an expected-not-implemented marker, so it doubles as a checklist for the next iteration. Deletion would have lost the catalog entirely. The HTTP-driven counterparts for each fixme (where one exists) are implemented and run today.

## 4. HTTP-driven specs preferred over DOM-driven specs where possible

The mocked tier specs lean heavily on Playwright's `request`-style usage by calling `app.fetch(new Request(...))` directly through the in-process `ControlApp` instance. The fixture exposes `app` precisely so specs can:

- inject session cookies without page navigation,
- inspect the response body/status directly,
- run in parallel without a real browser,
- avoid coupling to UI markup that changes shape.

Reserved for browser-driven specs: anything where the regression is in the React state machine, the iframe boundary, or browser-visible side effects (XSS rendering, cookie attributes seen by `document.cookie`, multi-tab sync via storage events). That mix produces a fast, mostly-server-side suite that catches the highest-value regressions (proxy hop-by-hop strip, default-deny gating, admin role enforcement, SSRF URL validation, CSRF cookie scoping).

## 5. Decisions on smaller details

- **`fast-check` for property tests.** Adopted as planned. Property tests live in `apps/control/src/__tests__/property/`, `apps/web/src/lib/*.property.test.ts`, and `packages/contracts/src/__tests__/property/`. Tunable run count via `FAST_CHECK_NUM_RUNS`.
- **Vitest for frontend unit tests, alongside Bun for the `keyboard-mapping.test.ts` file.** That one test was written before this work in `bun:test`-style and runs under `bun test`; the Vitest config excludes it to avoid double-runs. New frontend tests go in Vitest.
- **No tsconfig coverage of `e2e/`.** `scripts/typecheck.ts` enumerates tsconfig projects and `e2e/` is not one. Adding it would require a fourth tsconfig and is unnecessary for a test directory that Playwright transforms with its own pipeline. If a future tsconfig project is added for `e2e/`, the contracts/control-plane imports in fixtures will already resolve via the workspace's package layout.
- **Docker smoke tests skip cleanly when `DOCKER_E2E` is unset.** The spec body is a `test.skip(...)` guard. This keeps the `e2e:docker` lane opt-in and avoids accidental Docker daemon traffic during regular dev work.
- **Property-test count default = 200.** Plan suggested 100. 200 is still under a second per property; the cost is negligible, the bug-surfacing benefit is real. Override via `FAST_CHECK_NUM_RUNS` for CI-time tradeoffs.

## Files Touched

- `package.json` — new scripts: `test:web`, `e2e`, `e2e:ui`, `e2e:debug`, `e2e:docker`, `e2e:security`, `e2e:report`. Added `fast-check` and `@playwright/test` dev deps.
- `apps/web/package.json` — new scripts: `test`, `test:watch`, `test:coverage`. Added `vitest`, `@vitest/coverage-v8`, `jsdom`, `@testing-library/{react,jest-dom,user-event}`.
- `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts` — new Vitest configuration.
- `apps/control/src/__tests__/property/*.ts` — property tests for URL/branch/slug/contracts.
- `apps/control/src/__tests__/security/*.ts` — SSRF, path-traversal, command-injection, session/admin, hop-by-hop header tests.
- `apps/web/src/{lib,hooks,state}/**/*.test.{ts,tsx}` — frontend unit + hook tests.
- `packages/contracts/src/__tests__/property/schemas.property.test.ts` — JSON round-trip + bound enforcement.
- `playwright.config.ts`, `e2e/global-setup.ts` — Playwright configuration.
- `e2e/fixtures/{app,auth,runtime,fake-vscode,fake-halsim,types}.ts` — Playwright fixtures.
- `e2e/page-objects/*.po.ts` — Page-object skeletons.
- `e2e/specs/**/*.spec.ts` — Mocked, Docker, and security spec files.

## Future Work (Deferred)

- Real OAuth-callback path coverage via a fake provider fixture (see §2).
- `data-testid` attributes on the components listed in the fixmed specs, plus filling in those specs.
- A second runtime provider mock helper for `simulateRuntimeFailure`, `injectGradleLockError`, etc. — the current `MockWorkspaceRuntimeProvider` covers basic state seeding but does not yet model crash transitions or per-call exec failures.
- Wire the suite into CI. The mocked tier is designed to drop into a GitHub Actions job with `bun + chromium`; the Docker tier requires a runner with the Docker socket. Out of scope for this pass.
- Better Auth `testUtils` adoption if upstream stabilizes the plugin and we want to use it for the auth-callback specs.
