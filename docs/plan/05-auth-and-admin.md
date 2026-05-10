# Plan 05 — Auth + admin view

## Context

Today, "login" is a username-picker form: the user types a name, the control
plane creates or fetches a `user` row and a `workspace`, and signs a session
cookie. There is no identity verification, no allowlist, no role model. Admin
endpoints exist (`/admin/status`, `restart-code`, `stop-containers`,
`seed-template`, `backup`, `restore`) but are protected only by localhost
binding plus an optional `ADMIN_TOKEN` env var — there's no UI for them.

This plan does two things together because they share the user/role model:

1. **Auth.** Replace the username picker with [betterauth](https://www.better-auth.com/),
   add an email allowlist, and wire up GitHub + Google OAuth.
2. **Admin view.** Build a shadcn-based admin UI gated by an `admin` role,
   layered over existing endpoints plus a few new ones.

## Out of scope

- SAML / Okta / enterprise SSO (future plan if needed).
- Self-service password reset — there are no passwords; OAuth only.
- Audit log / activity history (could be a future plan).
- Real-time admin updates via WebSocket — polling is fine for the scale we're
  at.
- Project importer UI — see [Plan 06](06-project-importer.md).

## Dependencies

- **[Plan 03](03-ui-scaffolding.md)** must land first. The login page and
  admin UI both use shadcn primitives.
- Plan 01 should have renamed the cookie to `frc_session`. If it hasn't, do
  the rename here (cheap).

## Tasks

### A. Auth

#### A.1 Install and configure betterauth

**Integration principle:** build around Better Auth's default model. If Better
Auth's user IDs, session shape, table names, or route conventions differ from
the current cookie-era contracts, adjust this app's APIs/contracts to match
Better Auth cleanly. Do not wrap Better Auth in compatibility hacks just to
preserve `usr_*` IDs or the old `sessions` table semantics.

- `cd apps/control && bun add better-auth` for the server side.
- `cd apps/web && bun add better-auth` for the React client. Same
  package; the client-only entrypoint is `better-auth/react` (see A.8).
- Create `apps/control/src/auth/` with:
  - `auth.ts` — betterauth `betterAuth({...})` instance.
  - `providers.ts` — GitHub + Google provider config.
  - `allowlist.ts` — load + validate the email allowlist.
- Backend: SQLite (reuse the existing `data/app.db`). Betterauth supports
  Bun + SQLite directly. Let betterauth own its tables (`user`, `account`,
  `session`, `verification`). Migrate the existing `users` table only where
  preserving local dev data is useful; for production shape, prefer
  Better Auth's generated schema and adapt our app around it.
  - **Note:** betterauth's `user` and the existing `users` table conflict.
    Prefer renaming/dropping ours and moving simulator-specific fields to
    `workspaces` or Better Auth `additionalFields`, whichever is more idiomatic
    after checking the current Better Auth docs.
  - Decide during execution which path is cleaner; document in a decision
    log (`docs/decisions/014-betterauth-integration.md`).

#### A.2 OAuth providers

- Add GitHub + Google OAuth via betterauth's built-in provider config.
- Document required env vars in `docs/runbook.md`:
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `OAUTH_REDIRECT_URL` / base URL config required by Better Auth.
- Choose and document the Better Auth mount path before implementation. Better
  Auth defaults to an API auth base path; use that default unless there is a
  strong reason to configure `/auth/*`. The public-route allowlist in A.7 must
  match the actual chosen path exactly.
- For local dev, document how to register OAuth apps with localhost callbacks.

#### A.3 Email allowlist

- File: `data/allowlist.json` (gitignored). Schema:
  ```json
  {
    "emails": ["coach@frcteam.org"],
    "domains": ["frcteam.org"]
  }
  ```
- Load at startup; expose via a simple in-memory cache plus a
  `reloadAllowlist()` function the admin UI can call.
- Hook into betterauth's `signIn` callback: if the OAuth-returned email is
  not on `emails` and its domain is not in `domains`, throw with a clear
  error message. Show a friendly "You're not on the roster — ask your coach"
  page.
- CLI helper: `bun run allowlist:add <email-or-domain>` (e.g.,
  `scripts/allowlist.ts`). Append to `data/allowlist.json` atomically.
- CLI helper: `bun run allowlist:list` and `bun run allowlist:remove`.

#### A.4 Cookie + session

- Cookie name `frc_session` (renamed in Plan 01). Betterauth manages the
  session; the existing signed-cookie code in [apps/control/src/cookies.ts](../../apps/control/src/cookies.ts)
  is deleted in favor of betterauth's session middleware.
- HttpOnly + SameSite=Lax + Secure (in prod) — defaults betterauth gives.
- The auth-from-request helper becomes:
  `auth.api.getSession({ headers: req.headers })` per betterauth docs.

#### A.5 Workspace creation on first login

- On betterauth `signUp` / first-login event, create the `workspace` row
  linked to the Better Auth user id:
  - Generate a slug from the user's email (`first.last@team.org` →
    `first-last`). Collisions get a numeric suffix.
  - Seed `data/users/<workspaceId>/project/` from
    `templates/wpilib-java-command/`.
- Existing `workspaces` table stays (still referenced by container leases), but
  its `user_id` column now stores Better Auth's user id. Update contracts and
  tests if the id no longer matches `usr_[a-f0-9]{32}`.

#### A.6 Roles

- Add a `role` column on betterauth's user table (`student` | `admin`,
  default `student`). Use betterauth's `additionalFields`.
- Admin endpoints check `role === "admin"` rather than localhost+token.
  Keep `ADMIN_TOKEN` as a break-glass fallback (e.g., for first-time
  bootstrapping when no admin user exists yet).
- CLI: `bun run users:promote <email>` to set `role=admin`. Reverse:
  `bun run users:demote <email>`.

#### A.7 Authorization architecture (default-deny)

Today auth is per-route opt-in: each handler calls `authFromRequest` and
`resolveWorkspaceRequest` itself. A handler that forgets these helpers is
silently unauthenticated. Plans 04, 06, 07 add ~15 new endpoints — too many
places to rely on memory. Flip the default during the betterauth migration.

**A.7.1 Public route allowlist.** Define one list in
`apps/control/src/auth/middleware.ts`. Anything not on it requires a
session. Allowed unauthenticated:

- `/login` (page)
- Better Auth's mounted auth routes, using the path chosen in A.2
  (for example `/api/auth/*` if using the default). Better Auth manages these;
  we just mount them.
- `/scope/*` (AS Lite static assets — student-only data flows through
  the per-workspace `/u/{slug}/sim/nt4` WS, which IS gated)
- `/health` (if added later)
- Static shell HTML (returns the shell; the shell client redirects to
  `/login` when it sees a 401 from the session-status endpoint)

Everything else 401s without a session. **No exceptions.**

**A.7.2 Middleware helpers.** All in `apps/control/src/auth/middleware.ts`:

- `requireSession(req) → Session` — `auth.api.getSession`. 401 on miss.
- `requireWorkspaceOwnership(req, slug) → { session, workspace }` —
  calls `requireSession`, then verifies the resolved user owns the
  workspace by slug. 403 on mismatch. Replaces today's
  `resolveWorkspaceRequest`.
- `requireAdmin(req) → Session` — calls `requireSession`, then checks
  `session.user.role === "admin"`. 403 if not. Honors `ADMIN_TOKEN` as
  break-glass (see A.7.5).

The HTTP router calls exactly one of these at the top of each
non-public handler. WebSocket upgrade handlers do the same **before**
sending the upgrade response — never accept-then-validate.

**A.7.3 WebSocket upgrade auth.** Three WS endpoints today/soon:
`/u/{slug}/ws/run` (existing), `/u/{slug}/sim/nt4` (existing),
`/u/{slug}/sim/halsim` (Plan 04), `/u/{slug}/project/import-stream`
(Plan 06). All four call `requireWorkspaceOwnership` before
`Sec-WebSocket-Accept`. The upgrade handler also validates the `Origin`
header against `OAUTH_REDIRECT_URL`'s host (with a localhost exception
for dev) — prevents cross-site WebSocket hijacking.

**A.7.4 CSRF.** Betterauth's defaults — `SameSite=Lax` on the session
cookie + Origin/Referer checks on state-changing requests — cover the
HTTP surface. The WS Origin check (A.7.3) covers the upgrade path. No
custom CSRF tokens needed.

**A.7.5 Break-glass admin token.** `ADMIN_TOKEN` env var still works
for `/admin/*` requests via `Authorization: Bearer <token>`. Documented
as "first-admin bootstrap only; rotate by changing env + restart". When
present and matched, `requireAdmin` returns a synthetic session with
`user.email = "<admin-token>"` so [Plan 07](07-hardening.md)'s audit
log distinguishes token-driven actions from real admins.

**A.7.6 Coverage test.** Add `apps/control/src/__tests__/auth.test.ts`
test: enumerate the registered routes (export the route table from the
router so tests can introspect it), assert each entry either is on the
public allowlist OR fails 401 when called without a session. New routes
that opt out of auth must add themselves to the public allowlist
explicitly — this is the lint.

#### A.8 Web client integration

Better Auth ships a React client at `better-auth/react` from the same
package — no second auth lib. Set it up once at
`apps/web/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";
export const authClient = createAuthClient({
  baseURL: window.location.origin,
});
```

Use it for:

- **Login page (A.9):** the GitHub/Google buttons call
  `authClient.signIn.social({ provider, callbackURL })`. No custom fetch.
  `callbackURL` should land on a post-login route that resolves or creates the
  user's workspace and redirects to `/u/<slug>/`; do not use `/` unless `/` is
  changed to perform that redirect.
- **Session reads:** `authClient.useSession()` returns
  `{ data: session, isPending, error }` and updates reactively. Use it
  inside the `useSession` hook stub introduced in
  [Plan 03](03-ui-scaffolding.md) — that hook becomes a thin wrapper
  around `authClient.useSession()` plus the workspace-slug bootstrap.
- **Heartbeat removal:** today's 60s heartbeat against
  `/api/session/heartbeat` exists to extend the cookie TTL. Betterauth
  rotates sessions automatically, so the heartbeat hook can be deleted.
- **Logout:** `authClient.signOut()` from the topbar dropdown.

#### A.8.1 Contract/API migration

- Update [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts)
  to reflect Better Auth's user/session IDs and session response shape.
  Specifically audit `USER_ID_PATTERN`, `SESSION_ID_PATTERN`,
  `sessionResponseSchema`, admin user schemas, and any test fixtures that assume
  `usr_*` / `ses_*` ids.
- Expose the minimum app session payload the web shell needs:
  authenticated user identity, role, workspace id, workspace slug, and display
  name/email. Prefer Better Auth session customization over a separate wrapper
  cookie.
- Existing `/u/{slug}/api/session` may remain as an app-specific convenience
  endpoint, but it should be backed by `auth.api.getSession(...)` and the
  workspace table, not the deleted `sessions` table.

#### A.9 Login page

- Replace the username form at the existing login route with a shadcn
  `<Card>` containing two buttons: "Sign in with GitHub", "Sign in with
  Google". Each button calls `authClient.signIn.social(...)` from A.8.
  Shows the project name + a one-line tagline.
- Allowlist denial: dedicated page with a clear "you're not on the roster"
  message and a mailto link to the coach (configurable). Triggered by
  the OAuth callback receiving a betterauth error from the allowlist
  hook (A.3).

### B. Admin

#### B.1 Routing

- Web shell adds a `/admin` route. Use a small client-side router (just check
  `window.location.pathname` and conditionally render `<App />` vs
  `<AdminApp />` — no need for react-router unless multiple admin sub-routes
  warrant it; in that case use react-router-dom).
- Server-side gate: `/admin/*` HTML returns 403 unless the session's role is
  `admin`.

#### B.2 Admin component tree

`apps/web/src/admin/`:

```
AdminApp.tsx             # Top-level wrapper, role guard, providers
AdminLayout.tsx          # Sidebar nav + content area
pages/
  Dashboard.tsx          # Overview cards
  Containers.tsx         # Running containers table
  Workspaces.tsx         # Workspaces + disk usage
  Users.tsx              # User list + role management
  Allowlist.tsx          # View/add/remove allowlisted entries
hooks/
  useAdminPoll.ts        # 5–10s polling helper for tabular data
```

#### B.3 Admin UI feature set

**Dashboard:**
- Active workspaces (count, capacity)
- Total memory used (sum across containers)
- Active build count (post-queue removal: just count of running builds)
- Recent activity (last 10 logins / runs / errors)

**Containers:**
- Table: workspace slug, container ID, state, ports (sim/vscode/halsim),
  memory (live), CPU% (live).
- Actions per row: Stop, Restart code container, Open editor (link to
  `/u/<slug>/`).

**Workspaces:**
- Table: slug, owner, last seen, project disk size.
- Actions per row: Backup, Restore (file picker), Delete (with confirm).

**Users:**
- Table: email, name, role, created at, last seen.
- Actions: Promote / Demote, Remove.

**Allowlist:**
- Two lists: emails, domains.
- Add field + delete buttons per row.
- "Reload from disk" button (if someone edited `data/allowlist.json` by
  hand).

#### B.4 New control-plane endpoints

All under `/admin/*`. Auth: role check + break-glass `ADMIN_TOKEN`.

| Method + path | Purpose |
| --- | --- |
| `GET /admin/containers/stats` | Wraps a single `docker stats --no-stream` snapshot |
| `GET /admin/workspaces/disk-usage` | Returns per-workspace project size in bytes |
| `GET /admin/users` | List users with role + last-seen |
| `POST /admin/users/:id/promote` | Set role=admin |
| `POST /admin/users/:id/demote` | Set role=student |
| `DELETE /admin/users/:id` | Delete user + workspace + container (chained) |
| `GET /admin/allowlist` | Return current allowlist |
| `POST /admin/allowlist` | Add an entry (`{ kind: "email" \| "domain", value }`) |
| `DELETE /admin/allowlist/:value` | Remove |

Existing per-workspace endpoints (`restart-code`, `stop-containers`,
`backup`, `restore`, `seed-template`) stay; admin UI calls them.

#### B.5 Polling

- 5-second interval for Containers + Dashboard pages (real-time-ish enough).
- 10-second for Workspaces, Users, Allowlist (less critical).
- Pause polling when the tab is hidden (`document.visibilityState`).
- `useAdminPoll(fn, ms)` hook handles all of this.

### C. Tests

- `apps/control/src/__tests__/auth.test.ts` — extend with: allowlist
  enforcement (rejected email gets clear error); OAuth callback happy path
  with a mocked provider; role-gating on `/admin/*` endpoints.
- `apps/control/src/__tests__/idle-and-admin.test.ts` — extend with the new
  admin endpoints (containers/stats, allowlist CRUD, users CRUD).
- Web: light component tests for the role guard (admin sees nav, student
  sees 403) and the allowlist add/remove flow.

## Files modified / created / deleted

**Modified:**
- `apps/control/src/app.ts` (replace cookie auth with betterauth middleware,
  new admin endpoints)
- `apps/control/src/storage.ts` (workspace creation hooks into betterauth)
- `apps/control/src/config.ts` (OAuth env vars)
- `packages/contracts/src/index.ts` (Better Auth id/session shapes)
- `apps/web/src/App.tsx` (mount admin router conditionally)
- `docs/runbook.md` (auth setup, OAuth registration, role management)

**Created:**
- `apps/control/src/auth/{auth,providers,allowlist,middleware}.ts`
- `apps/web/src/lib/auth-client.ts` (betterauth React client)
- `apps/control/migrations/007_betterauth_tables.sql` (or generated by
  betterauth's CLI — check)
- `apps/control/migrations/008_user_roles.sql`
- `scripts/allowlist.ts` (CLI helper, drives all 3 commands)
- `scripts/users.ts` (promote/demote)
- `data/allowlist.json` (gitignored — `.gitkeep` in dir if needed)
- `apps/web/src/admin/AdminApp.tsx`
- `apps/web/src/admin/AdminLayout.tsx`
- `apps/web/src/admin/pages/{Dashboard,Containers,Workspaces,Users,Allowlist}.tsx`
- `apps/web/src/admin/hooks/useAdminPoll.ts`
- `apps/web/src/components/LoginPage.tsx` (replaces username form)
- `docs/decisions/014-betterauth-integration.md`

**Deleted:**
- `apps/control/src/cookies.ts` (replaced by betterauth session)
- The username-picker login UI bits in the web shell

## Verification

1. **OAuth happy path (GitHub):** with a fresh `data/app.db`, start the dev
   stack. Sign in with GitHub. The email is on the allowlist (add it first
   with `bun run allowlist:add <your-github-email>`). Workspace gets
   provisioned, redirected to IDE.
2. **OAuth happy path (Google):** repeat with Google.
3. **Allowlist denial:** remove your email + domain from the allowlist, sign
   out, sign in again. See "you're not on the roster" page. No workspace
   created.
4. **Role gate:** as a student, navigate to `/admin` — get a 403 page. Run
   `bun run users:promote <your-email>`, refresh, navigate to `/admin` — see
   the dashboard.
5. **Admin actions:**
   - Stop a peer student's container from the Containers page; their browser
     shows the container as stopped (status pill flips).
   - Promote a peer to admin; they refresh and see `/admin` works for them.
   - Add a domain to the allowlist via the UI; reload the file from disk and
     verify the new entry persisted.
6. **Logout:** click logout. Cookie is cleared. Hitting `/u/<slug>/` redirects
   to the login page.
7. **Tests:** `bun run test` green, including the new auth + admin coverage.
8. **Break-glass:** with no admin user yet, `ADMIN_TOKEN` set, `curl -H
   "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4000/admin/users` —
   returns the user list. (Used to bootstrap the first admin.)
