# 020 - Workspace runtime provider boundary

## Status

Accepted.

## Context

The V2 control plane was built around local Docker. Lifecycle orchestration,
status, proxy target discovery, simulation runs, and project imports all knew
about Docker container names or `docker exec`. That kept the classroom deployment
simple, but made a future remote runtime such as Fly Machines difficult because
callers would need another large refactor to stop assuming localhost ports and
Docker CLI arguments.

## Decision

Introduce an internal `WorkspaceRuntimeProvider` boundary. The default provider
is `LocalDockerRuntimeProvider`, instantiated once per `createApp()` after
storage is created. Tests and future deployments may pass `runtimeProvider`
through `ControlAppOptions`; that explicit provider takes precedence over the
Docker construction hooks.

The provider returns `WorkspaceRuntime` objects with provider-neutral state plus
upstream endpoint URLs for VS Code, NT4, and HALSim. Callers use those URLs
instead of assembling `127.0.0.1:<port>` themselves. Local Docker still records
ports in `container_leases` for admin compatibility and restart reconciliation.

The provider also owns in-workspace command execution:

- `exec()` for bounded commands such as import steps and `stop-sim.sh`.
- `execStream()` for long-running run/log streaming.

## Consequences

- Docker-specific command construction is isolated in the local provider.
- App routes, run control, imports, idle teardown, and bridges depend on runtime
  behavior rather than Docker CLI shape.
- A future remote provider can map workspace IDs to remote machines and return
  authenticated/internal endpoint URLs without changing route-level code.
- The provider is not a module-level singleton; each app instance owns exactly
  one provider instance, avoiding test state leaks and preserving per-app locks.
