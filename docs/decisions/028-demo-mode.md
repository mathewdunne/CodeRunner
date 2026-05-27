# 028 — Demo mode for zero-config local tryout

**Status:** accepted
**Date:** 2026-05-27

## Context

Cloning the repo and running `bun install && bun run build && bun run start`
is not enough to actually use CodeRunner. A new visitor must register OAuth
apps (GitHub and/or Google), wire their client IDs/secrets into env vars,
and add their email to an allowlist — before they ever see the IDE. That's
a tall wall for someone who just wants to evaluate the project.

We want a single flag that lets `bun run start` come up in a self-contained
"try it" mode where the visitor is logged in automatically.

## Decision

Add a `--demo` CLI flag (also reachable via `CODERUNNER_DEMO_MODE=1`) that
flips a `config.demo` boolean. When demo mode is on:

1. **Seed**: on boot, idempotently insert a single user row
   (`id = demo_admin_local_user`, role `admin`, slug `demo`) and call
   `ensureWorkspaceForUser` to materialize its workspace files.
2. **Synthetic session**: `getSessionFromRequest` short-circuits and
   returns a canned session for the demo user — no DB session row, no
   cookie, no Set-Cookie middleware. Every consumer of the gate
   (`requireSession`, `requireWorkspaceOwnership`, `requireAdmin`) sees a
   logged-in admin.
3. **`/api/auth/get-session` override**: the dispatcher intercepts that one
   Better Auth route in demo mode and returns the synthetic session in
   Better Auth's response shape, so `authClient.useSession()` on the
   frontend resolves immediately.
4. **No OAuth providers**: `createAuth` passes `socialProviders: {}` so
   missing client secrets do not crash boot. The "no providers configured"
   warning is suppressed in this mode.
5. **Visible warnings**: `main.ts` prints a five-line `DEMO MODE ENABLED —
   do not deploy publicly` banner before "listening". The workspace shell
   renders a thin yellow banner above the topbar whenever
   `sessionResponse.demo === true`.

## Why synthetic over real sessions

The alternative was to mint a real Better Auth session row at boot or on
first request and inject a Set-Cookie. Synthetic sessions are cleaner:

- No DB write per visitor, no race between cookie minting and the request
  that needed the session.
- `auth.api.getSession` is never called in demo mode, so Better Auth's
  internal flow is untouched (no need to reason about HMAC signing, cookie
  prefixes, or refresh windows in two code paths).
- Logout becomes a no-op (the cookie is cleared, but the next request
  resolves the synthetic session again) — acceptable for a demo.

## Constraints

- **Not safe for public deployment.** Every visitor resolves to the same
  admin user. There is no privacy boundary between concurrent visitors.
  The README, banner, and boot-time log warning all call this out.
- The demo user row is real and persisted to `data/app.db`. Stopping the
  server and restarting without `--demo` leaves the row in place but the
  synthetic-session shortcut no longer fires, so the row is dormant.
- Docker is still required — the editor and run path live in containers.
  `--demo` only removes the auth wall, not the workspace runtime.

## Affected code

- `apps/control/src/config.ts` — `demo` field on ControlConfig.
- `apps/control/src/auth/demo.ts` — new helper with constants, seed, and
  synthetic-session factories.
- `apps/control/src/auth/middleware.ts` — `getSessionFromRequest` short
  circuit; signature refactored to take `AppStorage` instead of `Auth`.
- `apps/control/src/auth/auth.ts` — empty `socialProviders` in demo mode.
- `apps/control/src/app.ts` — seed on construction, intercept
  `/api/auth/get-session` route.
- `apps/control/src/main.ts` — `--demo` argv parse + warning banner.
- `apps/control/src/storage.ts` — skip the "no OAuth providers" warning in
  demo mode.
- `apps/control/src/app/responses.ts` — `sessionResponse` accepts a
  `{ demo }` option and surfaces it on the API.
- `apps/control/src/app/workspace-routes.ts` — pass `demo` through.
- `packages/contracts/src/index.ts` — optional `demo` boolean on
  `SessionResponse`.
- `apps/web/src/components/DemoBanner.tsx` — new banner component.
- `apps/web/src/routes/WorkspacePage.tsx` — render the banner when
  `session.demo === true`.
- `apps/control/src/__tests__/auth-demo.test.ts` — coverage for seeding,
  bypass, idempotency, and the off-mode negative path.
