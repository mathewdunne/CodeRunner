# 008 - V1 LSP container and Bun-native bridge

**Status:** Implemented (V1-7)
**Date:** 2026-05-07

## Context

V1-7 introduces per-workspace Eclipse JDT LS containers and a control-plane WebSocket
proxy at `/u/<workspaceSlug>/ws/lsp`. The MVP single-user LSP image used Node, `npm`,
`vscode-ws-jsonrpc`, and the `ws` library. The V1 stack rule is Bun-first, and the
multi-tenant spike already proved that per-user containers are the right shape.

This note records the V1-7 implementation choices that future LSP, idle teardown, and
operator tasks should preserve.

## Decisions

### Bun-native bridge instead of `vscode-ws-jsonrpc`

The V1 LSP container ships its own WebSocket-to-stdio bridge written in Bun TypeScript
(`containers/lsp/bridge/bridge.ts`). It listens on `:30003/jdtls`, spawns a JDT LS
subprocess per WebSocket connection via `Bun.spawn`, and translates between JSON-RPC
WebSocket frames and `Content-Length`-framed stdio messages.

The MVP bridge depended on `vscode-ws-jsonrpc`, `vscode-languageserver-protocol`, and
`ws` running on Node. Bringing those into the V1 image would have required either
keeping Node alongside Bun in the LSP container or porting the bridge anyway. The
Bun-native bridge is ~140 lines, has no external dependencies, and reuses the existing
browser-side hand-rolled JSON-RPC client from the MVP web app.

Spawning JDT LS per connection mirrors the MVP behavior: each browser session gets a
fresh JDT LS process and the container holds no JDT LS state when no client is
connected. This matches the V1-8 idle/teardown direction better than a long-lived
shared subprocess.

### Mounts mirror the sim image

The LSP runtime mounts:

```
data/users/<workspaceId>/project    -> /workspace/project
data/users/<workspaceId>/jdtls-data -> /workspace/jdtls-data
data/users/<workspaceId>/home       -> /home/frc
```

The Gradle/WPILib cache primed during image build is copied to `/opt/frc-gradle-cache`
and seeded into the mounted `/home/frc/.gradle` on first run, the same trick the sim
image uses to keep the warm cache when the home directory is bind-mounted. This is what
lets `reset-lsp-data` (V1-8) wipe the JDT LS index without losing the warm cache or the
project files.

### `container_leases` lease state split

The original schema kept a single `state` column on `container_leases`. V1-7 adds a
sibling `lsp_state` column (migration `003_lsp_state.sql`) so the sim and LSP container
states can move independently. The orchestrator and SQLite upsert paths handle each
role separately and never let one failure mask the other in the status response.

### Generic `ContainerOrchestrator`

The sim and LSP containers use the same Docker labels (`frc-sim.managed=true`,
`frc-sim.version=v1`, `frc-sim.role=<role>`, `frc-sim.workspace=<workspaceId>`), the
same loopback-only host port policy, and the same restart-time adoption from labels.
The orchestrator was generalized in V1-7 to take a `ContainerRole` so the sim path,
LSP path, and any future container roles share the same reconciliation, port reservation,
and adoption code.

### Browser LSP client extended for multi-file projects

`apps/web/src/java-lsp.ts` is the V1 successor to the MVP single-file LSP module. It
now manages a map of open Monaco models, fans out hover/completion/diagnostics/semantic
token requests to whichever model the user is editing, and forwards
`workspace/didCreateFiles`, `workspace/didDeleteFiles`, `workspace/didRenameFiles`, and
`workspace/didChangeWatchedFiles` notifications when the file API mutates the project.
Renames also re-bind Monaco models to the new URI so JDT LS sees `didOpen` on the new
path, satisfying the V1-7 contract that creating a new Java class appears in
completions/diagnostics without restarting the app.
