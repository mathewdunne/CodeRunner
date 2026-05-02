# 008 — Wiring the LSP through the backend and into Monaco

**Status:** Browser-side adapter superseded by [009](./009-stock-monaco-vscode.md) (2026-05-02). Backend `/lsp` route, framing translator, and graceful-shutdown logic remain in force.
**Date:** 2026-05-01

## Superseded by 009 (browser side only)

The backend half of this decision — `@fastify/websocket` for `/lsp`, the `LspFrameParser` translation between Content-Length-prefixed jdtls stdio and bare JSON-RPC over WebSocket text frames, the graceful `shutdown` + `exit` sequence on socket close, the stale `/workspace/jdtls-data/.metadata/.lock` recovery — was correct and stays.

The browser-side hand-rolled adapter (`apps/web/src/lsp-setup.ts`, ~432 lines built on `vscode-jsonrpc` directly) was walked back. Symptoms that motivated the reversal:

- jdtls 1.58 starts cleanly, OSGi initializes, Buildship's `ProjectRegistryRefreshJob` finishes in 853 ms, then nothing further happens. No completions, no diagnostics, no `language/status: ServiceReady` notification.
- On shutdown, jdtls logs `PreferenceManager.getClientPreferences()` returns null — a known indicator that the client's `initializationOptions.extendedClientCapabilities` were never recorded against the session.
- Adding the `extendedClientCapabilities` block to `initializationOptions` (per `vscode-java`'s payload) did not fix it.
- Three debug cycles narrowed the symptom but did not isolate the exact mismatch. The most likely cause is a subtle init-payload or framing edge case the hand-rolled adapter and jdtls 1.58 disagree on — exactly the kind of mismatch `monaco-languageclient` eliminates by being the same client `vscode-java`, [vscode.dev](https://vscode.dev), and Gitpod use.

The cost-of-debug-remotely was clearly higher than the cost-of-stock-library, so we adopted `monaco-languageclient` + `@codingame/monaco-vscode-api`. The `documentSelector`-based wiring drives jdtls with messages it has known how to read for years, and the broken handshake is a non-problem. See decision 009 for the full reversal.

The historical browser-adapter sections below remain accurate for the period 2026-05-01 → 2026-05-02 and are kept for posterity.

---

## Context

With jdtls installed in `frc-lsp:mvp` (decision 007), the remaining job is connecting it to Monaco in the browser. Three layers of wiring:

1. Bridge a browser WebSocket to jdtls's stdio in the backend.
2. Translate Monaco's editor events into LSP requests/notifications and translate LSP responses back into Monaco markers, completion items, and hover tooltips.
3. Make sure the document URI Monaco uses matches what jdtls sees on disk so completions and diagnostics line up with the right file.

## Decisions

### `@fastify/websocket` for both `/run` and `/lsp`

Decision 004 had `/run` hand-rolled on `app.server.on("upgrade", ...)` because the original constraint was "no npm available, can't add @fastify/websocket". That constraint disappeared during M1 (vscode-textmate, vscode-oniguruma added). For M2 we needed a *bidirectional* WS for `/lsp` — the previous `WebSocketTextPeer` only handled outbound text frames and would have grown into a full RFC 6455 client/server.

The plugin is dropped in once, and now serves both routes:

```ts
await app.register(fastifyWebsocket, { options: { maxPayload: 4 * 1024 * 1024 } });

app.get("/run", { websocket: true }, (socket) => { void handleRun(new RunPeer(socket)); });
app.get("/lsp", { websocket: true }, (socket) => { handleLsp(socket); });
```

`/run`'s status/log/exit JSON shape is unchanged. `RunPeer` is a thin shim around `ws.WebSocket` that keeps the existing `peer.sendJson()` / `peer.onClose()` / `peer.close()` interface so `handleRun` did not need rewriting. The hand-rolled `WebSocketTextPeer`, `acceptWebSocket`, and `makeTextFrameHeader` were deleted.

### LSP framing translation: Content-Length on the wire, plain JSON over WS

LSP's stdio transport prefixes each message with `Content-Length: N\r\n\r\n`. Browser WebSocket text frames are message-oriented already — adding the LSP framing on the wire would duplicate length info that WebSocket carries natively.

The convention used by `vscode-ws-jsonrpc` (and by extension monaco-languageclient) is "one JSON-RPC message per WS text frame, no Content-Length header on the WS side." The backend implements that:

- **WS → jdtls stdin**: prepend `Content-Length: <byte-len>\r\n\r\n` to the body and write to stdin.
- **jdtls stdout → WS**: a small `LspFrameParser` state machine reads headers until a blank line, then reads N body bytes, then emits the body as a single WS text frame. Buffered for chunked stdout reads; resilient to `Content-Length` headers split across chunks.

This is exactly what `vscode-jsonrpc`'s `StreamMessageReader` does internally; we re-implement it in the backend rather than introducing a server-side dependency, because the parser is ~50 lines and the dependency would otherwise pull in the whole `vscode-jsonrpc` transport stack just for one class.

### Hand-rolled Monaco LSP adapter, not `monaco-languageclient`

The plan called for `monaco-languageclient`. During implementation we found that every recent version of that library (v6+) requires swapping `monaco-editor` for `@codingame/monaco-vscode-editor-api` and pulls in ~30 transitive `@codingame/monaco-vscode-*` packages to provide service shims. That is not a drop-in; it's a meaningful migration with real risk of breaking the working TextMate theme stack from M1 (decision 005) which depends on the regular `monaco-editor` API surface.

The web shell only needs four LSP features for the MVP:

- diagnostics (server pushes `textDocument/publishDiagnostics`),
- completion (`textDocument/completion`),
- hover (`textDocument/hover`),
- document sync (`textDocument/didOpen`, `didChange`).

A direct adapter in `apps/web/src/lsp-setup.ts` (~280 lines) wires these four features, using:

- `vscode-jsonrpc` for the JSON-RPC framing layer (small, stable, no Monaco coupling). We provide custom `MessageReader`/`MessageWriter` implementations that read/write JSON objects directly over a WebSocket.
- `monaco.editor.setModelMarkers` for diagnostics.
- `monaco.languages.registerCompletionItemProvider` and `registerHoverProvider` for completions and hovers.

This keeps the MVP dependency footprint tight and matches the codebase's existing pattern of hand-rolling small adapters (the TextMate runtime, the `/run` framing, the `LineSplitter`). When the codebase is rewritten post-MVP, swapping in `monaco-languageclient` becomes a clean replacement of one file with a known interface.

The trade-off is that long-tail LSP features (semantic tokens, code lens, signature help, refactoring actions, inlay hints) would each need a few lines of additional adapter code. None of those are in scope for M2.

### Monaco model URI matches the LSP container path

The model is now created with an explicit URI:

```ts
monaco.Uri.parse("file:///workspace/project/src/main/java/frc/robot/Robot.java")
```

This matches the path jdtls sees on disk inside `frc-lsp-mvp`. Consequences:

- `textDocument/didOpen`, `didChange`, and completion/hover requests reference a URI jdtls can resolve to a real file in its workspace.
- `publishDiagnostics` from jdtls (which arrive with that URI) match the editor's model when filtering markers in the diagnostic notification handler.

If the URI did not match, jdtls would happily complete and provide diagnostics, but they would never show up in the editor because `setModelMarkers` is keyed on the model.

### `lsp-loading` status pill

A new `Status` value `"lsp-loading"` is set immediately after editor creation and stays until `startLanguageClient(...).ready` resolves. This makes the cold-start latency of jdtls visible to the user instead of leaving the pill at `idle` while completions silently don't work yet. Once the language client reports ready, the pill drops to `idle`.

### Ready ≠ initialize response

The first iteration resolved `ready` when jdtls responded to the `initialize` request. That arrives within a second of spawn — but jdtls then spends another 30–90s running Buildship's Gradle import to resolve the WPILib classpath, and completion requests during that window return empty. The status pill flipped to `idle` while completions were still silently broken, which was confusing.

The fix: resolve `ready` on jdtls's `language/status` notification with `type: "ServiceReady"` (or `"Started"`), not on the `initialize` response. jdtls emits `ServiceReady` after Buildship's import completes, which is the real signal that completions/diagnostics are wired up. The browser timeout was bumped to 180s to accommodate cold gradle imports.

### Clean shutdown on socket close, with stale-workspace recovery

Initial implementation: when the WebSocket closed, the backend immediately `SIGTERM`'d the jdtls process. This was fine in steady state but corrupted the workspace if the kill landed during Gradle import — jdtls leaves a `.metadata/.lock` file behind, and the next session's jdtls tries to resume from the half-imported workspace and silently never finishes (`ServiceReady` never arrives, the browser sits at `lsp-loading` until the 180s timeout).

Two-part fix in `apps/server/src/main.ts:handleLsp`:

1. **Graceful shutdown.** On socket close, write a fresh `shutdown` request followed by an `exit` notification to jdtls's stdin, end stdin, and give the process up to 5s to flush its workspace state and exit on its own. Fall back to SIGTERM on timeout. Backend log shows `jdtls exited code=0` instead of `signal=SIGTERM` when this works.
2. **Stale-workspace recovery on next connect.** Before spawning jdtls for a new session, `pgrep` for any running `org.eclipse.jdt.ls` process inside the LSP container; if none exists but `/workspace/jdtls-data/.metadata/.lock` is still present, that's a stale lock from a previous crash. The backend `rm -rf /workspace/jdtls-data && mkdir -p /workspace/jdtls-data` and lets jdtls do a fresh import. Logs `stale jdtls-data lock detected; clearing workspace`.

Together these make the lsp-restart loop robust: even if jdtls is hard-killed (browser tab killed, container OOM, dev:mvp terminated mid-import), the next browser reload converges to a working state instead of needing a manual `docker exec ... rm -rf /workspace/jdtls-data`.

## Future work surfaced

- One jdtls process per WS connection. Reusing a single process across sequential connections would cut reconnect latency from ~5s warm to ~50ms but requires session multiplexing in the framing.
- Save-on-Run currently still flows through `POST /file` independently of LSP. If we ever care about diagnostics being authoritative for "this file as the user has edited it", `textDocument/didChange` already handles that — we just don't gate Run on diagnostics.
- Code formatting, organize-imports, semantic tokens are all easy follow-ons in the adapter when the user asks for them.
