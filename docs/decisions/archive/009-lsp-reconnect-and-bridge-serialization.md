# 009 - LSP reconnect, bridge serialization, and startup throttling

**Status:** Implemented (V1-7 cleanup)
**Date:** 2026-05-07

## Context

V1-7 shipped per-workspace JDT LS containers, a Bun-native bridge, and a
browser LSP client. Review against V1-8's planned operator surface (`restart-lsp`,
`reset-lsp-data`) and V1-9's resource-tuning goals turned up three correctness
gaps that would have forced rework when those phases landed:

1. The browser LSP client treated any connection failure as terminal and never
   set `"reconnecting"` even though the status enum reserved that state. An
   operator restarting a stuck LSP container would have forced students to
   refresh the browser.
2. The bridge spawned a fresh JDT LS process on every WebSocket connection
   without waiting for the previous one to release `${JDTLS_DATA}/.metadata/.lock`.
   Two browser tabs, an HMR refresh, or any operator-driven container restart
   could race two JDT LS instances against the same data dir.
3. Class-start bursts (10 students opening the IDE simultaneously) produced 10
   concurrent `docker run` invocations, each pulling a JDK plus priming the
   Gradle cache. The spike noted JDT LS cold-start cost dominates classroom
   resource use; the V1 orchestrator had no throttle.

This note records the V1-7 cleanup decisions so V1-8 and V1-9 agents do not
re-litigate them.

## Decisions

### Decision 1: Browser LSP client auto-reconnects with bounded backoff

`startJavaLsp()` in `apps/web/src/java-lsp.ts` now wires the underlying
`BrowserLspClient`'s `onClose` event to a reconnect loop. On any close after
successful init the controller:

- Sets status to `"reconnecting"`, disposes hover/completion/semantic-tokens
  providers, and clears all Monaco markers in the `"jdtls"` owner so the user
  doesn't see stale diagnostics.
- Schedules a reconnect using a fixed schedule `[1s, 2s, 5s, 10s]` capped at
  10s, with no maximum retry count. Operators kill broken sessions by stopping
  the container or telling the student to close the tab.
- On a successful reconnect, replays `textDocument/didOpen` for every model
  in the controller's `managed` map and re-registers providers.

`dispose()` aborts the in-flight reconnect timer and any in-flight
`bootstrap()` attempt.

### Decision 2: Bridge serializes JDT LS spawns

`containers/lsp/bridge/bridge.ts` now spawns the JDT LS subprocess inside
the `fetch` handler **before** calling `instance.upgrade(...)`, and a
module-level `previousProcessExit` promise gates each new spawn behind the
prior subprocess's `exited` resolution. This collapses three problems at once:

- Eclipse JDT LS's data-directory lock conflict is impossible because the
  prior process has fully exited before the next is spawned.
- The pre-existing message-drop window in `websocket.message` (where messages
  arriving before `Bun.spawn` completed were silently discarded) is closed:
  by the time the upgrade returns, `data.process` is already set.
- A 2-second warmup delay (`LSP_FIRST_CONNECTION_WARMUP_MS`) on the very
  first connection after bridge boot covers the rare case where a prior
  bridge process's JDT LS is still releasing the lock during a `docker stop`
  → `docker start` cycle.

### Decision 3: Orchestrator-level LSP startup throttle

A counting semaphore in `ContainerOrchestrator` (`Semaphore` in
`apps/control/src/containers.ts`) caps concurrent `docker run` invocations
for the LSP role only. Default permits = 2, configurable via
`LSP_STARTUP_CONCURRENCY`. The semaphore wraps only the create path inside
`ensureContainerInner`; adopt-existing flows (`docker start` on a labeled
container) acquire no permit because they're effectively free.

Sim creates are not throttled here because the existing `RUN_CONCURRENCY`
queue already bounds simultaneous Gradle work, which is the more expensive
sim-side burst.

### Decision 4: Cap proxy pending-message buffers

The NT4 and LSP proxy paths in `apps/control/src/app.ts` now close the
browser-side socket with code `1013` ("Try Again Later") if `pendingMessages`
reaches 256 entries while waiting for upstream to open. Prevents a
misbehaving sim that accepts TCP but never finishes the WS handshake from
ballooning control-plane memory.

### Decision 5: NT4 subprotocol mismatch is fail-fast, not silent

The NT4 proxy continues to echo the browser's first requested subprotocol
during the upgrade handshake (Bun has no clean way to defer the upgrade on
async upstream I/O). When the upstream `open` event fires, the proxy
inspects `upstream.protocol` and, if it differs from what the browser was
told, closes the browser-side socket with code `1002` ("Protocol Error")
rather than silently routing frames between mismatched protocols. AS Lite
will reconnect with a clear failure rather than appearing stuck.

### Decision 6: AS Lite in-iframe timeout banner

Patch `001-lite-nt4-endpoint-injection.patch` now sets a 10s timer in the
embedded-mode handshake. If no endpoint message arrives, AS Lite renders an
in-iframe error banner instead of staying on `show-when-ready` indefinitely.
Complements the existing `Scope timeout` label in the web shell for
defense-in-depth — a misbuilt parent app surfaces visibly.

## Implications

### V1-8

- `restart-lsp` becomes a thin wrapper around `docker stop` + `docker start`
  on the labeled LSP container; the bridge's serialization handles spawn
  ordering and the browser auto-reconnect handles client-side recovery.
- `reset-lsp-data` similarly: stop container → delete
  `data/users/<workspaceId>/jdtls-data/` → recreate the dir → start container.
  No additional client coordination is needed.
- Idle teardown does not need to coordinate with the bridge; the next user
  return triggers `ensureLspContainer` which respects the throttle.

### V1-9

- `LSP_STARTUP_CONCURRENCY` is the knob to tune against the target host's
  measured CPU/RAM headroom. Default 2 is a starting guess.
- `LSP_FIRST_CONNECTION_WARMUP_MS` can be lowered to 0 if measurement shows
  no stale-lock window after `docker stop` → `docker run`.
