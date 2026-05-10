# 007 - V1 sim container orchestration

**Status:** Implemented (V1-4)
**Date:** 2026-05-05

## Context

V1-4 introduces the first per-workspace runtime infrastructure in the Bun control plane: a mounted-project sim
container, a `container_leases` row, loopback-only NT4 port allocation, and a student-visible status endpoint.

The V1 design already selected Docker CLI orchestration through Bun. This note records the implementation details
that future run/NT4/LSP tasks should preserve.

## Decisions

### Lazy ensure, visible status

Opening `/u/<workspaceSlug>/` starts sim container ensure in the background so the IDE shell is not blocked by Docker
startup or a missing image. The status endpoint, `GET /u/:workspaceSlug/api/containers/status`, awaits reconciliation
and returns `running`, `starting`, `stopped`, or `error`.

This keeps the browser route responsive while still satisfying the phase contract that opening a workspace initiates
container startup. Later run and NT4 routes should call the same orchestrator instead of duplicating Docker state
checks.

### Docker labels are adopted back into SQLite

The orchestrator looks for managed sim containers by the expected name and by labels:

```text
frc-sim.managed=true
frc-sim.version=v1
frc-sim.role=sim
frc-sim.workspace=<workspaceId>
```

When a labeled container exists after a control-plane restart, SQLite is updated from Docker's published port and
runtime state. SQLite remains useful history/cache, but Docker labels are the runtime source of truth.

### Loopback-only published ports

Sim NT4 is published only as `127.0.0.1:<allocatedPort>:5810`. If reconciliation finds a managed sim container
published on a non-loopback host address, it removes and recreates the container. Browser routes must continue to use
control-plane paths rather than this port directly.

### UID/GID strategy

The sim image creates a non-root `frc` user. On native Linux, the control plane defaults `--user` to the current
process UID/GID unless `FRC_CONTAINER_USER` or `FRC_UID`/`FRC_GID` is set. On Docker Desktop/Windows, the image default
user is used unless explicitly configured. Gradle cache, sim logs, and PID files live under the mounted `/home/frc`
workspace home so they are regenerable and separate from `project/`.

This is the piece that lets files produced in the bind mount remain readable and removable by the host control plane
without making the container run as root.

### Runtime cache seed

Real Docker verification caught an interaction between cache priming and the `/home/frc` bind mount: the Gradle cache
created during image build would be hidden by an empty mounted workspace home. The image now copies the primed cache to
`/opt/frc-gradle-cache`, and the entrypoint seeds a fresh mounted `GRADLE_USER_HOME` from that directory before starting
the sim. This preserves the V1 mounted-home contract without giving up warm startup behavior.
