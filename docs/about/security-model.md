---
sidebar_position: 4
title: Security Model
---

# Security Model

This page describes how CodeRunner gates access, isolates students from each
other, and limits what a container can do. It is written for operators who need
to evaluate whether CodeRunner is safe to deploy on their network.

## Authentication

Sign-in is handled by [Better Auth](https://www.better-auth.com/) using OAuth.
GitHub and Google are the supported providers; you configure one or both by
supplying their client ID and secret as environment variables
(`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`). If a provider's credentials are absent it is simply
not offered on the login page.

Sessions are stored in the SQLite database and tracked with a signed cookie
named `coderunner_session`. The signing key is the `BETTER_AUTH_SECRET`
environment variable. Sessions expire after 14 days; the expiry is silently
refreshed daily while the student is active.

## Email allowlist

OAuth alone is not enough to sign in. After the OAuth provider confirms a
user's identity, CodeRunner checks whether the returned email address is on the
**allowlist** (`data/allowlist.json`). The check runs in two places (on new
user creation and again on every OAuth callback), so a removed entry takes
effect at the next login attempt.

**Auth0 sign-ins skip the allowlist.** When Auth0 is configured, the operator's
Auth0 tenant is trusted to decide who gets in: CodeRunner reads a roles claim
from the Auth0 ID token at every Auth0 sign-in and admits the user only if it
holds the configured user or admin role (the admin role grants CodeRunner
admin). A user whose roles are removed in Auth0 is denied at their next sign-in,
before any session is issued; sessions they already hold run until they expire.
See [Set up Auth0](../deploying/oauth-credentials.md#set-up-auth0).

The allowlist accepts individual addresses and whole domains. A team using
`@frcteam1234.org` Google Workspace accounts can add that domain once rather
than listing every member. The file format is:

```json
{
  "emails": ["coach@example.com"],
  "domains": ["frcteam1234.org"]
}
```

An admin can manage the allowlist through the admin UI or the admin API.

## Admin role

Users have a `role` field: `student` (the default) or `admin`. Admin-only
routes require the session's role to be `admin`. An operator can also use a
static break-glass token (`ADMIN_TOKEN`) by passing it as a `Bearer` token in
the `Authorization` header. This is intended for automated tooling and
one-off operator commands, not for day-to-day use.

## Single entry point

The control plane is the only process that listens on a public port (default
`4000`, set by `PORT`). Web shell, AdvantageScope, and PathPlanner static assets
are public. Workspace-specific editor traffic, commands, telemetry, gamepad
input, and file requests require a session and enter through that same port.

How workspace container ports are exposed depends on deployment mode. In
**port mode** (the host dev loop, `bun run dev:control`) each container's
ports are bound to `127.0.0.1` only. In **network mode** (the default for
`docker compose` deployments) workspace containers publish no host ports at
all — they join a private Docker network and the control plane reaches them
by container name over Docker's internal DNS. Either way, no container port is
reachable from outside the host, even if the host firewall is misconfigured,
and there is no way for a student to connect to another student's container
directly from a browser. See
[decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md) for the two
modes.

## Control plane container privileges

In the standard `docker compose` deployment, the control plane runs as a
container and needs the host Docker socket bind-mounted so it can manage
per-student containers as siblings. That container runs as a **non-root**
uid:gid — the user that owns the bind-mounted data directory (`CODERUNNER_UID`
/ `CODERUNNER_GID`, defaulting to `1000:1000`), with the host `docker` group
gid added as a supplementary group (`CODERUNNER_DOCKER_GID`) so the non-root
process can still reach the socket. Running non-root keeps the data directory
host-owned rather than root-owned and reduces the blast radius of a compromise.

It does **not** eliminate it: the mounted socket still grants full control of
the host's Docker daemon, so a remote-code-execution bug in the control plane
remains effectively a container escape — the socket is the primary privilege
surface and the only writable host mount besides the data directory. This is
the same trust level as the pre-containerized deployment (the host user running
the control plane process was a member of the `docker` group), just repackaged.
Operators evaluating CodeRunner for a shared network should weigh this alongside
the [demo mode](#demo-mode) warning below. See
[decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md) for the full
rationale.

## Per-workspace access enforcement

All workspace routes are under `/u/<slug>/...`. Before serving any request
under that prefix the control plane:

1. Resolves the session from the signed cookie.
2. Looks up the workspace record by slug.
3. Confirms that the workspace's `user_id` matches the authenticated user's ID.

A student whose session is valid but whose slug does not match the URL receives
a `403`. An unauthenticated request is redirected to the login page for browser
requests or returns `401` for API requests. There is no mechanism for a student
to reach another student's editor, simulator, or files through normal routes.

PathPlanner's app files under `/pathplanner/` contain no student data and are
served publicly, like AdvantageScope's `/scope/` assets. Its deploy-files API
is under `/u/<slug>/api/deploy-files/`, so the ownership check above applies.
The API exposes only `src/main/deploy/pathplanner/**` and
`src/main/deploy/choreo/**`; writes and deletes are limited to the PathPlanner
subtree.

## Preview isolation

Project HTML is untrusted. Preview runs it in an opaque-origin sandbox, so it
cannot access the CodeRunner page, browser storage, cookies, or authenticated
APIs. The same sandbox is sent as a response header for direct links. Its CSP
also blocks network connections and adds a best-effort navigation restriction.
Markdown runs with scripts disabled.

Sandboxed frames do not receive the session cookie, so local report assets use
a signed, workspace-specific path token that expires after fifteen minutes.
Preview routes are read-only, capability URLs are not logged, and responses are
not cached. Path validation, file type allowlists, symlink checks, and read
limits keep the endpoint inside the student's project. The full rationale is in
[decision 041](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/041-project-preview.md).

## Container isolation

Each student's container:

- Runs under a non-root host UID/GID, so container files are owned by a real
  user rather than root. On the host dev loop this is the control plane
  process's own UID/GID; in containerized (`docker compose`) deployments the
  control plane derives it by `stat()`ing the bind-mounted data directory
  (or an explicit `FRC_CONTAINER_USER` override) and refuses to start if that
  resolves to root — see [decision 031](https://github.com/mathewdunne/CodeRunner/blob/main/docs/decisions/031-containerized-control-plane.md).
- Has a hard memory cap enforced by Docker's cgroup limit (default `4096m`,
  set by `CODE_MEMORY_LIMIT`). A runaway robot program cannot exhaust host
  memory. Disk reads are likewise throttled per device (default `64mb`, set
  by `CODE_DISK_READ_LIMIT`) so a single container cannot monopolize host
  disk throughput.
- Has its three ports bound on `127.0.0.1` only in port mode, or published
  nowhere at all in network mode; either way it has no inbound network
  exposure beyond what the control plane itself proxies.

The `MAX_ACTIVE_CONTAINERS` limit (default `10`) prevents a single deployment
from spinning up more containers than the host can sustain, reducing the blast
radius of an unusually large concurrent session spike.

## Audit log

Significant actions (sign-in, workspace creation, run start/stop, project
loads, and admin operations) are written to an `audit_log` table in the
SQLite database. Each entry records the actor's user ID and email, the action,
an optional target, and a millisecond timestamp. Admins can query the log
through the admin API.

## WebSocket origin validation

Before upgrading any WebSocket connection the control plane validates the
`Origin` header against the configured `BETTER_AUTH_URL`. Cross-origin
WebSocket upgrades are rejected with `403`. Loopback aliases
(`localhost` / `127.0.0.1`) are treated as equivalent to support local
development, but production deployments served over a real hostname are not
affected by that exception.

## Demo mode

Starting the control plane with `--demo` (or `CODERUNNER_DEMO_MODE=1`) bypasses
OAuth entirely: every request is treated as a single synthetic admin session.
This is designed for zero-configuration local evaluation only.

**Demo mode must never be deployed publicly.** There is no privacy boundary
between concurrent visitors in demo mode: all requests resolve to the same
user. The control plane prints a multi-line warning banner at startup and the
workspace shell displays a yellow banner to make this visible. See
[Deploying](../deploying/overview.md) for how to configure OAuth for a real
deployment.

## What CodeRunner does not provide

Operators should be aware of the following boundaries:

- **No network egress restriction on containers.** A robot program running
  inside a container can make outbound network requests. If your environment
  requires egress filtering, that must be applied at the host or network level.
- **No code scanning.** Student code is compiled and executed as-is. CodeRunner
  does not scan or sandbox the robot program's behavior beyond the container's
  cgroup memory limit.
- **TLS termination is the operator's responsibility.** CodeRunner speaks plain
  HTTP on its single port. A reverse proxy (nginx, Caddy, or a cloud load
  balancer) must provide TLS. See [Deploying](../deploying/overview.md).
