# Decision 016 — Project Import Strategy

**Status:** accepted
**Date:** 2026-05-10

## Context

Students need a way to import existing FRC robot code from GitHub into their
workspace — for example, last year's competition code, a vendor template, or a
teammate's project. The current system only seeds from the bundled WPILib
template on first login.

## Decision

### Clone inside the container, not the host

The `git clone` runs via `docker exec` inside the student's running V2 code
container. This avoids:

- Adding a host-side git dependency to the control-plane requirements.
- Bind-mount permission issues (the container filesystem and the workspace
  bind-mount share the same UID/GID).
- Blast radius: a misbehaving clone (slow network, malicious `.gitmodules`)
  is confined to the container and its process limits.

The Dockerfile now installs `git` explicitly alongside the existing system
packages.

### Strip `.git/` after clone

Imports are one-way snapshots. We strip the `.git/` directory before swapping
the clone into `/workspace/project` because:

- There is no push-back-to-GitHub support and no git credentials in the
  container. A leftover remote origin would let students attempt a `git push`
  that always fails.
- Large repos can have hundreds of megabytes of git objects. Stripping the
  history keeps workspace disk usage predictable.
- The mental model is "snapshot import" — students get the code, not the
  history. If they want to revert, they restore the pre-import backup.

### Public-only, GitHub-only for v1

Supporting private repos requires broader OAuth scopes and secure token
storage — a larger plan. Similarly, GitLab/Bitbucket parsing is deferred
until requested. GitHub public HTTPS URLs cover the vast majority of FRC
team repos.

### 100 MB size cap

A shallow clone (`--depth 1`) of most FRC repos is well under 50 MB. The
100 MB cap prevents accidental import of monorepos (e.g., `torvalds/linux`)
that would exhaust workspace disk. The cap is checked after clone via
`du -sb` inside the container.

### 6 imports per hour rate limit

In-memory per-user rate limit prevents accidental UI spamming. Six per hour
is generous for legitimate use while bounding the container workload from
repeated large clones.

### Swap contents, not the mount point

`/workspace/project` is a Docker bind mount. Removing and recreating the
directory would break the mount. Instead, the import clears the directory
contents and copies the new files in, preserving the mount point.

### Backup before import

By default, the control plane creates a `.tar.gz` backup of the current
project before swapping in the import. Backups are stored at
`data/users/<workspaceId>/backups/import-<timestamp>.tar.gz` with a sibling
`.json` metadata file. A maximum of 5 import backups are kept per workspace;
the oldest is pruned on each new import.

### Streaming progress via WebSocket

The import uses a dedicated WebSocket at `/u/{slug}/ws/import`, following the
same pattern as the run channel. The client opens the socket, sends the
import request as the first message, and receives progress/log/done/error
messages. This keeps the import decoupled from the POST validation endpoint.

## Consequences

- The code container image grows slightly with the addition of `git`.
- Students cannot push back to GitHub or access private repos.
- Import backups consume disk; the 5-backup cap and the operator backup
  system provide cleanup paths.
- Future work: private repo support (Plan TBD), download/export (Plan TBD).
