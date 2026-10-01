# 043 — Classroom join codes

Status: **Accepted** — 2026-09-30

## Context

At team meetings new members rotate through a CodeRunner station every ~20
minutes on school computers. OAuth sign-in on those machines is impractical,
and adding each visitor to the allowlist is not feasible. We still need
something between "anyone on the internet" and "roster only" so bots cannot
create workspaces and hold container slots.

## Decision

An admin starts a **classroom** (default 4 h, 1–12 h) from the admin panel
and gets a random 6-digit code plus a join URL. At `/join` a student enters
the code and their name and becomes a **guest**: a Better Auth user with a
non-null `classroomId`, role `student`, a `guest-…@classroom.invalid`
email, and a normal workspace. Entering the same name again (with a
confirmation step) returns the student to the same workspace.
Impersonation by name is accepted: the threat model is resource abuse, not
student-to-student privacy. Because a guest identity is that loose, guests
are **never admins**: the promote route refuses them, and
`getSessionFromRequest` reports a guest's role as `student` whatever the
row says.

- **Custom Better Auth plugin** (`auth/classroom-plugin.ts`) creates the
  guest and session with Better Auth's own internal APIs and cookie
  handling, so every existing guard works unchanged.
- **Dispatcher** (`app/classroom-routes.ts`) in front of it: disabled in
  demo mode; rate limits *failed* attempts (10 per IP / 100 global per
  10 min) because a whole school shares one IP; retires the browser's
  previous session and stops a previous guest's container. It checks the
  limit, looks up the code, and records a miss in one tick before calling
  the plugin, so a parallel burst can't all pass the check; reserving
  every in-flight attempt instead would 429 a class joining at once from
  one school IP.
- **Lifetime:** guest sessions expire with the classroom, and
  `getSessionFromRequest` rejects guests of non-live classrooms. That check
  is needed because Better Auth's `updateAge` refresh would stretch a
  4-hour session to 14 days, and its 5-minute cookie cache would outlive
  "End now". For the same cache reason it also rejects a guest whose
  session row is gone (Leave, or a new join in that browser). The
  dispatcher answers Better Auth's own `GET /api/auth/get-session` with
  `null` whenever that check fails, so the web shell agrees.
- **Cleanup:** a 60 s `ClassroomSweeper` (and "End now") deletes guests,
  workspaces and project files via `deleteUserAndWorkspace`, shared with
  the admin user-delete route. A join registers itself as in flight in the
  same tick as its liveness check, and cleanup waits for a classroom's
  in-flight joins before listing its guests; otherwise a guest created
  just after the listing would outlive a classroom already marked cleaned.
  The 60-guest cap is enforced by reserving a slot in memory in the same
  tick as the count, because concurrent joins with different names would
  each see a free slot before any guest row commits.
- **Capacity:** guests get a **Leave** button that stops their container
  immediately. With 20-minute rotations and a 30-minute idle reaper,
  containers would otherwise still be running when the next group signs in.
  `POST /u/:slug/api/leave` signs the guest out (Better Auth `signOut`, whose
  cookie-clearing headers ride on the response) *before* stopping the
  container, because the IDE keeps polling until the page navigates and an
  authenticated poll would start the container again. Stopping the
  workspace (Leave, a replaced guest session) and deleting a user (End now,
  the sweeper) also close its open run/import/lesson-load/gamepad sockets:
  they keep the workspace they authenticated with, so an open `/ws/run`
  could otherwise still start a run after sign-out.

## Alternatives rejected

- **Better Auth `anonymous` plugin.** Always creates a new user (no
  rejoin-by-name), has no way to carry the code/name through its endpoint
  without splitting logic across three hooks, uses the global 14-day
  session, and deletes the anonymous user when someone later signs in with
  OAuth in the same browser. That would orphan our workspace rows,
  container and files. It would save about 30 lines.
- **Signing session cookies ourselves** (as `e2e/fixtures/auth.ts` does).
  Duplicates Better Auth's cookie format and breaks silently on upgrade.
- **Station links** (one pre-signed account per computer). Simpler, but
  gives students no identity of their own, so they can't come back to
  their work.

## Constraints

- Guest columns are Better Auth `additionalFields`; the unique
  `(classroomId, guestNameKey)` index is created in
  `AppStorage.initialize()` after Better Auth's migrations, because the
  `user` table does not exist when our SQL migrations run.
- The per-IP bucket trusts the rightmost `X-Forwarded-For` hop (our
  Caddy). Without a proxy it is spoofable; the global bucket bounds
  guessing to ≈0.24 % per live code over 4 h.
- **Known limitation:** behind the Cloudflare Pages front, Caddy's peer is
  a Cloudflare egress IP, so that rightmost hop is Cloudflare's, not the
  student's, and the per-IP bucket collapses into a few buckets shared by
  unrelated schools. A blocked bucket rejects valid codes too, so ten typos
  (or a stranger's guesses) on the same Cloudflare egress lock out new
  joins there for up to 10 minutes. Direct access to the main domain is
  unaffected. Deferred until it bites in practice. Follow-up:
  - `origin.<domain>` is DNS-only, which Cloudflare treats as a
    non-Cloudflare destination, so `CF-Connecting-IP` should already carry
    the student's IP on the Pages Function's subrequest (per Cloudflare's
    docs; confirm on the live deployment). The Function likely needs no
    change.
  - `trusted_proxies` alone is not enough: Caddy would keep the incoming
    `X-Forwarded-For` but still append Cloudflare's peer address, and
    `clientIp` reads the rightmost hop. Rewrite the header instead:
    ```caddy
    {
      servers {
        trusted_proxies static <Cloudflare IP ranges>
        client_ip_headers CF-Connecting-IP
      }
    }
    origin.{domain} {
      reverse_proxy control:4000 {
        header_up X-Forwarded-For {client_ip}
      }
    }
    ```
    `clientIp` then needs no change.
  - `origin.<domain>` is publicly reachable, so `trusted_proxies` must be
    limited to Cloudflare's published ranges or anyone can spoof
    `CF-Connecting-IP`. Confirm Pages Function subrequests egress from
    those ranges first.
- A determined attacker can trip the global bucket and block new joins
  for ~10 minutes. Already-joined guests are unaffected.
