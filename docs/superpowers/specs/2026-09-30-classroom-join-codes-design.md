# Classroom Join Codes — Design

**Date:** 2026-09-30
**Status:** draft, pending review
**Decision log to add:** `docs/decisions/043-classroom-join-codes.md`

## Problem

At a team meeting new members rotate through a CodeRunner station every ~20
minutes on school computers. Signing in with Google/GitHub on those machines
is impractical and roster (allowlist) setup per kid is not feasible. We want a
fast, low-ceremony way in that still keeps random bots from creating
workspaces and hogging containers.

## Agreed requirements

From the brainstorming conversation:

- **Per-kid identity, loose.** Each kid gets their own workspace and can come
  back to it later in the meeting by re-entering the same code and name.
  Impersonation (a kid typing another kid's name) is explicitly acceptable.
- **Throwaway lifetime.** Guest accounts and their projects live only as long
  as the classroom code (default 4 h), then are deleted automatically.
- **Scale.** ≤ 8 kids at a time, one computer each — fits the default
  `MAX_ACTIVE_CONTAINERS=10`, *provided departing kids release containers
  promptly*.
- **Bot resistance, not strong security.** Only a live code gets you in;
  guessing is rate-limited; guests per code are capped.

## Non-goals

- Converting a guest into a real (OAuth) account or keeping guest work past
  the classroom. Kids who stay on the team get a normal roster account later.
- QR codes. Students are on school desktops, not phones; the join URL and code
  are shown large enough to read off a screen or whiteboard.
- Changing how OAuth users log out, or the idle-reaper defaults.
- Demo mode support. The join endpoint is disabled when `config.demo` is on
  (every request is already the synthetic admin there).

## Approach

A small **custom Better Auth plugin** (`classroom`) exposing
`POST /api/auth/classroom/join`. It is modelled on Better Auth's built-in
`anonymous` plugin (same internal APIs: `internalAdapter.createUser`,
`internalAdapter.createSession`, `setSessionCookie`) so guests hold *real*
Better Auth sessions with Better Auth-managed cookies. Every existing guard —
`requireSession`, `requireWorkspaceOwnership`, WebSocket origin + session
checks, the Preview path token — works unchanged.

The built-in `anonymous` plugin was considered and rejected: it always creates
a new user (no rejoin-by-name), cannot carry the code/name through its
endpoint without splitting logic across three hooks, uses the global 14-day
session lifetime, and deletes the anonymous user when someone later signs in
with OAuth in the same browser (which would orphan our workspace rows,
container, and project files).

Signing cookies by hand (as `e2e/fixtures/auth.ts:loginAs` does) was also
rejected for production: it duplicates Better Auth's cookie format and would
break silently on upgrade.

## Data model

New migration `apps/control/migrations/012_classrooms.sql`:

```sql
CREATE TABLE classrooms (
  id TEXT PRIMARY KEY,              -- "cls_" + 32 hex
  code TEXT NOT NULL,               -- 6 digits, zero-padded
  created_by TEXT NOT NULL,         -- admin user id (or "<admin-token>")
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,                    -- set by "End now"
  cleaned_at TEXT                   -- set once the sweeper has deleted its guests
);
-- A code is only unique among classrooms that are still live; enforced in
-- code at creation (retry on collision) since "live" depends on now().
CREATE INDEX idx_classrooms_code ON classrooms(code);
```

The Better Auth `user` table is created by Better Auth's own
`runMigrations()`, which runs *after* our SQL migrations in
`AppStorage.initialize()`, so the guest columns cannot be added in `012`.
Instead `classroomId` and `guestNameKey` are declared as Better Auth
`user.additionalFields` (`input: false`, not required) alongside the existing
`role` and `slug` — Better Auth adds the columns, they flow through
`createUser`, and they come back on `getSession`. Right after
`runMigrations()`, `initialize()` runs:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_classroom_guest
  ON user(classroomId, guestNameKey) WHERE classroomId IS NOT NULL;
```

A user is a **guest** iff `classroomId IS NOT NULL`.

A classroom is **live** iff `ended_at IS NULL AND expires_at > now`.

## Guest identity

- **Display name:** trimmed, internal whitespace collapsed, 1–40 chars,
  letters (Unicode), digits, space, `-`, `'`, `.`. The form hints
  "First name + last initial (e.g. Alex D)".
- **Name key:** lower-cased, NFKD-normalised, diacritics stripped, whitespace
  and punctuation removed (`"Alex D."` → `alexd`). Uniqueness is per
  classroom via `idx_user_classroom_guest`.
- **Email:** `guest-<random>@classroom.invalid` (the reserved `.invalid` TLD
  can never collide with a real address or with `CODERUNNER_ADMIN_EMAIL`).
  Never shown in the UI.
- **Role:** always `student`.
- **Slug:** derived from the display name with the same normalisation as
  `slugFromEmail` (`"Alex D"` → `alex-d`); collisions with any existing
  workspace are resolved by `ensureWorkspaceForUser`'s existing suffix loop.

The existing `databaseHooks.user.create.before` in `auth/auth.ts` is updated:
when the incoming user has `classroomId`, skip the allowlist check, force role
`student`, and derive the slug from the name instead of the email. The OAuth
path is unchanged.

## Join flow

`POST /api/auth/classroom/join` with JSON `{ code, name, confirmExisting? }`.

The work is split between the control-plane dispatcher and the Better Auth
plugin. The dispatcher (`app/classroom-routes.ts:handleClassroomJoin`,
routed from `app.ts` ahead of the generic `/api/auth/*` pass-through) owns
everything that needs the socket IP or the runtime: demo gate, rate limit,
and replacing a previous guest's session (steps 1, 2, 6). The plugin owns
the identity work (steps 3–5, 7–8) and stays free of runtime dependencies,
because Better Auth is constructed in `AppStorage.initialize()` before any
runtime exists.

1. **Disabled in demo mode** → 404.
2. **Rate limit check** (see below) → 429 if the caller is locked out.
3. **Validate** `code` (exactly 6 digits) and `name` → 400 on shape errors.
4. **Find live classroom** by code. None → 404
   `"That code isn't valid or has expired."` (unknown vs expired are not
   distinguished). The dispatcher **records a failed attempt** for any 404
   the plugin returns.
5. **Find guest** by `(classroomId, nameKey)`.
   - Exists and `confirmExisting !== true` → 409 `{ reason: "name-taken",
     displayName }`. The UI asks "Alex D already joined this classroom — is
     that you?".
   - Exists and `confirmExisting === true` → reuse that user.
   - Does not exist → if the classroom already has **60 guests**, 403
     `"This classroom is full."`; otherwise create the user. A unique-index
     conflict from a concurrent join with the same name is caught and treated
     as "exists" (fall through to the 409 / reuse branch).
6. **Replace any session the browser already holds.** Before handing off to
   the plugin, the dispatcher resolves the request's current session (if
   any). After a 200 from the plugin it deletes that old session row, and if
   it belonged to a *different* guest it also stops that guest's container
   (the "previous kid walked away without leaving" case). Non-guest sessions
   are simply replaced.
7. **Ensure workspace** via the existing `ensureWorkspace` callback.
8. **Create session** with `expiresAt` = the classroom's `expires_at`
   (`internalAdapter.createSession(userId, false, { expiresAt }, true)`),
   then `setSessionCookie`. Respond 200 `{ ok: true, userId }` (the
   dispatcher uses `userId` for step 6); the client navigates to `/`, which
   already redirects to the user's workspace.
9. **Audit** `classroom.guest_join` (actor = the guest, metadata
   `{ classroomId, displayName, rejoin }`).

Plugin errors are thrown as Better Auth `APIError`s whose JSON body is
`{ code, message }` (plus `displayName` for `NAME_TAKEN`). Codes:
`INVALID_INPUT` (400), `INVALID_CODE` (404), `NAME_TAKEN` (409),
`CLASSROOM_FULL` (403). The dispatcher adds `RATE_LIMITED` (429) and
`DISABLED` (404, demo mode).

### Session validity for guests

`getSessionFromRequest` (`auth/middleware.ts`) gets one extra rule: if the
resolved user has a `classroomId` and that classroom is not live, return
`null`. This is the authoritative expiry check. It is required because:

- Better Auth's `updateAge` refresh would otherwise push a 4-hour guest
  session out to 14 days on first use, and
- Better Auth's 5-minute `cookieCache` would otherwise keep an ended
  classroom's guests signed in for up to 5 minutes after "End now".

The classroom lookup is a primary-key read on SQLite per request, only for
guests.

## Rate limiting

In-memory, in the dispatcher, counting **failed** join attempts only
(bad/expired code). Successful joins are never limited — every kid at the
school shares one public IP.

- **Per client IP:** 10 failures per rolling 10 minutes → 429 for the rest of
  the window.
- **Global:** 100 failures per rolling 10 minutes across all IPs → 429 for
  everyone until it drains. This keeps the guessing math independent of
  whether the client IP can be trusted: at most ~2,400 guesses over a 4-hour
  classroom against a 1,000,000-code space (≈0.24 % per live code).
- **Client IP:** the rightmost `X-Forwarded-For` entry (the one our Caddy
  appends) when present, else the socket address from Bun's
  `server.requestIP`. Assumes the documented Caddy front; in port/dev mode
  the per-IP bucket is spoofable, which the global bucket covers.

Accepted trade-off: a determined attacker can trip the global bucket and
block *new* joins for ~10 minutes. Already-joined guests are unaffected.

## Leaving and freeing containers

The key operational risk is capacity, not security: with 20-minute rotations
and the 30-minute idle reaper, departing kids' containers would still be
running when the next group arrives. And `/u/:slug/api/heartbeat` keeps a
workspace alive as long as a tab is open.

- **Leave button.** For guests, the user-menu "Logout" item becomes
  **"Leave"**. It calls a new `POST /u/:slug/api/leave` (session + workspace
  ownership required), which stops runs and the container exactly as the
  idle sweep's `onStop` path does (`runs.stopWorkspace`,
  `runtimeProvider.stopWorkspace`, halsim/nt4Auto/gamepad disconnect). The
  client then calls `authClient.signOut()` and goes to `/join`. The workspace
  and files are kept for rejoin.
- **Join replaces a stale guest** (step 6 above), so a new kid who ignores
  the previous kid's IDE and goes straight to `/join` still frees the
  container.
- The existing 30-minute idle reaper remains the backstop.

`/api/leave` is not restricted to guests server-side (stopping your own
container is harmless), but only guests see it in the UI.

## Expiry and cleanup

A `ClassroomSweeper` (new, `apps/control/src/classroom-sweeper.ts`) runs every
60 seconds alongside `IdleManager`. For each classroom that is not live and
has `cleaned_at IS NULL`, it deletes every guest user with that
`classroomId` and then sets `cleaned_at`.

"End now" sets `ended_at` and triggers the same cleanup immediately.

Per-user deletion is shared with the existing admin route: the body of
`DELETE /admin/users/:id` in `app/admin-routes.ts` (stop runs, stop and remove
the container, delete run_jobs/container_leases/workspaces/session/account/
user rows in a transaction, remove the project directory) moves into a helper
that both call. The admin route keeps its own last-admin guard and audit
event. The sweeper records one `classroom.cleanup` audit event per classroom
with `{ guestCount }`.

Guests also show up in the existing admin **Users** list and can be deleted
there individually.

## Admin surface

New admin routes, implemented in `app/classroom-routes.ts` and delegated to
from `handleAdminRoute` after its `requireAdmin` check:

| Method | Path | Behaviour |
|---|---|---|
| `GET` | `/admin/classrooms` | Live classrooms with their guests (display name, slug, joined at, workspace last-accessed). |
| `POST` | `/admin/classrooms` | Body `{ durationMinutes }` (60–720, default 240). Generates a random 6-digit code unique among live classrooms (`crypto.getRandomValues`, retry on collision). Returns `{ id, code, expiresAt, joinUrl }`. Audit `classroom.create`. |
| `POST` | `/admin/classrooms/:id/end` | Sets `ended_at`, runs cleanup. Audit `classroom.end`. |

New **Classrooms** tab in the admin SPA (`apps/web/src/admin/`), after
"Users":

- A "Start classroom" control with a duration choice (1 h / 2 h / 4 h / 8 h,
  default 4 h).
- For each live classroom: the code in large type, the join URL
  (`<baseUrl>/join?code=123456`) with a copy button, the time it ends, a
  guest list, and an **End now** button behind a confirm dialog.

Admin response shapes are typed locally in the page, matching the existing
admin pages (`Allowlist.tsx`, `Users.tsx`). The join request schema and the
session `guest` field go in `packages/contracts` because both the control
plane and the student UI use them.

## Student surface

- **`/join` route** (new `apps/web/src/routes/JoinPage.tsx`; server serves the
  web shell for `GET /join` next to `/login` in `app.ts`). One form with two
  fields: the 6-digit code (numeric input, non-digits stripped, pre-filled
  from `?code=`) and the name. A 409
  `name-taken` shows "**Alex D** already joined this classroom — is that
  you?" with **"Yes, that's me"** (resubmits with `confirmExisting: true`)
  and **"No, change my name"**. On success, `window.location.assign("/")`,
  which the existing root redirect sends to `/u/<slug>/`.
  `/join` renders the form even when a session exists (the join replaces it).
- **Login page** gains a "Join a classroom" link/button to `/join`, shown
  regardless of which OAuth providers are configured.
- **Session contract:** `sessionResponseSchema.user` gains optional
  `guest: { classroomEndsAt: string }`. `sessionResponse()` in
  `app/responses.ts` fills it for guests.
- **User menu** for guests: shows the display name and "Guest · ends
  3:45 PM" in place of the (fake) email; "Logout" becomes "Leave". No other
  guest-specific UI.

## Error handling summary

| Situation | Result |
|---|---|
| Bad shape (code not 6 digits, name empty/too long/invalid chars) | 400 with a field message |
| Unknown or expired code | 404 generic message; counts as a failed attempt |
| Rate-limited | 429 "Too many attempts — wait a few minutes." |
| Name already joined, not confirmed | 409 `name-taken` → confirm prompt |
| Classroom at 60 guests | 403 "This classroom is full." |
| Server at container capacity | Join still succeeds; the existing workspace "at capacity" state shows when the container can't start (unchanged behaviour) |
| Demo mode | 404 `DISABLED` on the join endpoint; `/join` shows that message on submit |
| Guest request after classroom ends | Treated as signed-out → redirected to `/login` by existing handling |

## Testing

**Control-plane (`bun run test`)**, new `apps/control/src/__tests__/classroom.test.ts`:

- join creates a guest user (`classroomId` set, role `student`, `.invalid`
  email, slug from name), workspace, and a session expiring at the
  classroom's `expires_at`
- the allowlist is bypassed for guests only; the OAuth allowlist tests stay
  green
- rejoin: same name → 409 without confirm, same user with confirm; name
  normalisation (`"alex d."` matches `"Alex D"`)
- unknown code and expired code → 404 and counted; ended classroom → 404
- per-IP and global rate limits → 429; successful joins are not counted
- guest cap → 403
- joining while holding another guest's session deletes that session and
  stops that guest's container
- `getSessionFromRequest` returns null for guests of ended/expired
  classrooms, even with a still-valid session row
- sweeper deletes guests + workspaces + project dirs and sets `cleaned_at`;
  idempotent on a second run
- admin routes: create/list/end, 60–720 duration validation, non-admin 403,
  code uniqueness among live classrooms
- `/api/leave` stops the container and keeps the workspace
- guest cannot reach `/admin/*`; demo mode disables the join endpoint
- the extracted user-deletion helper keeps `DELETE /admin/users/:id`
  behaviour identical (existing tests)

**Frontend (`bun run test:web`):** JoinPage (prefill from `?code=`,
409 confirm flow, error messages); UserMenu guest variant (Leave label,
"Guest · ends …").

**E2E (`bun run e2e`):** one spec — admin creates a classroom via API, a
student joins at `/join?code=…`, lands in the IDE, clicks Leave, rejoins with
the same name and confirms, lands in the same workspace.

## Docs

- `docs/decisions/043-classroom-join-codes.md` — the approach and the
  anonymous-plugin rejection above.
- `docs/using-coderunner.md` — a "Joining a classroom" section for students.
- `docs/operating/` — a coach-facing section on starting and ending a
  classroom and on capacity during rotations.
- `AGENTS.md` — one short "Classroom join codes (post-V2)" status paragraph.

## Affected code (expected)

- `apps/control/migrations/012_classrooms.sql` — new
- `apps/control/src/classrooms.ts` — new: storage helpers, code generation,
  name normalisation, guest queries, rate limiter
- `apps/control/src/classroom-sweeper.ts` — new: `cleanupClassroom` + `ClassroomSweeper`
- `apps/control/src/user-deletion.ts` — new: shared user + workspace delete
- `apps/control/src/auth/classroom-plugin.ts` — new: the Better Auth plugin
- `apps/control/src/auth/auth.ts` — register plugin, new additional fields,
  guest branch in the user-create hook
- `apps/control/src/storage.ts` — guest unique index after Better Auth
  migrations
- `apps/control/src/auth/middleware.ts` — guest liveness check
- `apps/control/src/app/classroom-routes.ts` — new: join dispatcher (rate
  limit, session replacement) and admin classroom routes
- `apps/control/src/app.ts` — route join + `/join`, start/stop the sweeper,
  shared `stopWorkspace`
- `apps/control/src/app/admin-routes.ts` — delegate classroom routes, use
  the user deletion helper
- `apps/control/src/app/workspace-routes.ts` — `POST /api/leave`
- `apps/control/src/app/responses.ts` — `guest` on the session response
- `packages/contracts/src/index.ts` — session `guest` field, classroom admin
  and join payload schemas
- `apps/web/src/App.tsx`, `routes/JoinPage.tsx`, `routes/LoginPage.tsx`,
  `components/UserMenu.tsx`, `admin/AdminLayout.tsx`,
  `admin/pages/Classrooms.tsx`
