---
sidebar_position: 1
title: Day-to-Day Operations
---

# Day-to-Day Operations

This page covers the routine tasks a mentor performs during an active season:
starting and stopping the app, managing who can sign in, and keeping an eye on
what the system is doing.

::::note[Running ops commands]

The maintenance commands in this page (`allowlist`, `users`, `audit-prune`,
`backup`, `restore`) run **inside the control container** via the `coderunner`
CLI:

```bash
docker compose exec control coderunner <subcommand> <args>
```

Use `docker compose run --rm control <subcommand> <args>` instead for a
one-off command while the control plane is stopped (e.g. `restore`). On the
Google Cloud VM the compose project lives in `/opt/coderunner` and needs
`sudo` (`cd /opt/coderunner && sudo docker compose exec -T control …`). On a
from-source host checkout with Bun you can instead use the `bun run <name>`
aliases shown in `package.json`. The examples below use the `bun run` short form;
substitute the `docker compose exec control coderunner <subcommand>` form for a
containerized deployment.

::::

## Starting and stopping

Both the local and Google Cloud deployments run the control plane as a docker
compose service. From the compose directory (the repo root locally, or
`/opt/coderunner` on the VM):

```bash
docker compose up -d        # start (runs DB migrations first, then serves)
docker compose stop         # stop the control plane
docker compose restart control
docker compose ps           # status — control should be "healthy"
docker compose logs -f control
```

Students connect to `http://<host-ip>:4000/` (or `https://<your-domain>/` behind
Caddy on the VM). Student workspace containers keep running after the control
plane stops and are reconciled automatically when it starts again. `restart:
unless-stopped` brings the stack back after a host reboot.

### Stopping workspace containers

Containers are not stopped when the control plane stops. To stop all running
student workspace containers:

```bash
# Stop and remove only stopped/exited managed containers
bun run docker:cleanup

# Force-stop all currently running managed containers
docker stop $(docker ps -q --filter label=frc-sim.managed=true)
```

You can also stop a single workspace's container via the admin API (see
[Admin API break-glass](#admin-api-break-glass) below).

### Between sessions

You do not need to stop containers manually between class sessions. The idle
sweep stops containers automatically after students have been inactive for the
configured timeout. The default is 30 minutes (`IDLE_STOP_MINUTES`); the cloud
VM deployment uses 10 minutes. Containers are reconciled on the next session
without any student-visible data loss.

---

## Managing who can sign in

Access is controlled by an allowlist of email addresses and domains. Sign-in
is via OAuth (GitHub and/or Google), but only emails that match the allowlist
are permitted through. An empty allowlist blocks everyone.

### Viewing the allowlist

```bash
bun run allowlist:list
```

### Adding an entry

Pass an individual email address or a whole domain. The script auto-detects
which kind you mean based on whether the value contains an `@`:

```bash
# Allow a specific person
bun run allowlist:add coach@frcteam.org

# Allow everyone at a domain (useful for team Google Workspace accounts)
bun run allowlist:add frcteam.org
```

### Removing an entry

```bash
bun run allowlist:remove old-member@frcteam.org
bun run allowlist:remove frcteam.org
```

Changes take effect immediately; the running control plane watches
`data/allowlist.json` and picks up edits without a restart.

---

## Managing user roles

The **first** admin is best bootstrapped without any exec step: set
`CODERUNNER_ADMIN_EMAIL` (comma-separated) in `.env` before the first startup
and those accounts are allowlisted and granted the admin role on first sign-in
(an existing account is promoted at the next startup). See
[OAuth Credentials](../deploying/oauth-credentials.md). The commands here are for
ongoing role changes after that.

After a coach or mentor signs in for the first time they are a regular user.
Promote them to admin so they can access the admin panel and use the admin API:

```bash
# List all users (shows ID, name, email, role, workspace slug)
bun run users:list

# Grant admin role (the user must already exist in the DB)
bun run users:promote coach@frcteam.org

# Remove admin role
bun run users:demote coach@frcteam.org
```

Admins can also promote and demote users from the admin panel in the browser.
The system prevents demoting the last remaining admin.

---

## Running a classroom session

For meetings where visitors rotate through a station, start a classroom
instead of adding people to the allowlist:

1. Open **Admin → Classrooms**, pick a duration (default 4 hours), and click
   **Start classroom**.
2. Show the code and join link (`https://<your-host>/join?code=…`) at the
   station. Students join with the code and their name.
3. Ask students to click **Leave** in the user menu when they finish. That
   signs them out and stops their container right away. If a student forgets, the next student
   joining on the same computer stops it for them, and the idle reaper
   (`IDLE_STOP_MINUTES`, default 30) is the backstop.
4. Click **End now** when you're done, or let the classroom expire. Its
   guests, workspaces, and projects are deleted automatically.

Each classroom allows up to 60 guests. Only running containers count
against `MAX_ACTIVE_CONTAINERS` (see [Capacity](./capacity.md)), so size it
for the number of computers in use at once, not the number of visitors.
Bad codes are rate-limited (10 failures per IP and 100 overall per
10 minutes); successful joins are never limited.

:::note[Known limitation: per-IP limit behind Cloudflare Pages]
The per-IP limit uses the address Caddy saw. Behind the Cloudflare Pages
front that is a Cloudflare egress IP, so students from many schools can
share one bucket and a burst of bad codes from one place can lock out
others for up to 10 minutes. The follow-up is to have the Pages Function
forward `CF-Connecting-IP` and configure Caddy `trusted_proxies` for
Cloudflare's ranges.
:::

## Container concurrency cap

The system limits how many workspace containers can run simultaneously to
prevent the host from being overloaded when many students sign in at once. The
default cap is **10** (`MAX_ACTIVE_CONTAINERS`).

When a student tries to open their workspace and the cap has been reached, they
see a toast: "Server at capacity. Your coach has been notified. Please try
again in a few minutes." Students with already-running containers are
unaffected.

### Checking and adjusting the cap at runtime

You can read and change the cap without restarting the control plane:

```bash
# Read current effective cap
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/admin/config/max-active-containers

# Set cap to 15
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST -H "Content-Type: application/json" \
  -d '{"value": 15}' \
  http://localhost:4000/admin/config/max-active-containers
```

The runtime override is stored in the database and takes precedence over the
environment variable until changed again. The admin panel also shows the current
cap and active container count with an inline editor.

---

## Audit log

All admin actions (promoting users, stopping containers, modifying the
allowlist, changing the concurrency cap) are recorded in the audit log.

### What is logged

| Action | Trigger |
|---|---|
| `user.promote` | Promoting a user to admin |
| `user.demote` | Demoting an admin |
| `user.delete` | Deleting a user and their workspace |
| `container.stop` | Stopping a workspace's containers |
| `container.restart-code` | Restarting a workspace's code container |
| `workspace.backup` | Creating an operator workspace backup |
| `workspace.restore` | Restoring a workspace from a backup |
| `allowlist.add` | Adding an email/domain to the allowlist |
| `allowlist.remove` | Removing an email/domain from the allowlist |
| `config.max-active-containers` | Changing the container concurrency cap |
| `classroom.create` | Starting a classroom |
| `classroom.end` | Ending a classroom early ("End now") |
| `classroom.cleanup` | Deleting an ended or expired classroom's guests (system) |
| `classroom.guest_join` | A guest joining or rejoining a classroom |

Each entry records the timestamp, the acting user (ID and email), the action,
the target (kind and ID), and optional metadata.

### Viewing the audit log

The admin panel has an "Audit Log" tab with filters by actor, action, and time
range.

Via the API:

```bash
# Latest entries
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/admin/audit-log

# Filter by action prefix
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?action=user&limit=50"

# Filter by actor email (substring match)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?actor=coach"

# Paginate using the smallest id from the previous page as cursor
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:4000/admin/audit-log?before=42&limit=25"
```

### Pruning old entries

Audit entries accumulate indefinitely. Prune them periodically:

```bash
# Remove all entries before a date
bun run audit:prune -- --before 2026-01-01

# Preview without deleting
bun run audit:prune -- --before 2026-01-01 --dry-run
```

Running this monthly is a reasonable cadence for a classroom deployment.

---

## Admin API break-glass

If `ADMIN_TOKEN` is set in your environment, you can call admin endpoints
directly with a bearer token. This is useful for scripting and for
bootstrapping before the first admin user has signed in.

```bash
# Overall system status: workspaces, container states, active builds
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:4000/admin/status | jq .

# Stop one workspace's containers
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST \
  http://localhost:4000/admin/workspaces/<workspaceId>/stop-containers

# Restart one workspace's code container
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  -X POST \
  http://localhost:4000/admin/workspaces/<workspaceId>/restart-code
```

If `ADMIN_TOKEN` is not set, admin endpoints require a signed-in admin session
cookie. The token is optional and intended as a break-glass mechanism, not as
the primary admin interface.
