# 009 — Stock `monaco-languageclient` + `@codingame/monaco-vscode-api`

**Status:** Implemented (post-MVP, supersedes 005 and 008)
**Date:** 2026-05-02

## Context

After M1 (decision 005, hand-rolled TextMate adapter) and M2 (decision 008, hand-rolled LSP adapter), the browser shell carried two bespoke runtime layers — `apps/web/src/textmate-setup.ts` (~290 lines) and `apps/web/src/lsp-setup.ts` (~432 lines) — that together reimplemented what `monaco-languageclient` and the `@codingame/monaco-vscode-api` extension ecosystem provide as standard library.

Both decisions were defensible at the time:

- **005** chose the bespoke TextMate runtime to avoid pulling in `@codingame/monaco-vscode-api`'s ~30 transitive deps and the consequent `monaco-editor` → `@codingame/monaco-vscode-editor-api` migration. The cost was a vendored Java grammar and three vendored Dark Modern theme JSONs.
- **008** chose a hand-rolled LSP adapter for the same reason: the four LSP features needed for the MVP (diagnostics, completion, hover, document sync) are well-scoped enough that a direct adapter was cheap and avoided the ecosystem migration M1 had been built to dodge.

Both decisions assumed M1's avoidance bought enough value to be worth maintaining a parallel runtime. M2's adapter then went broken: jdtls 1.58 starts, OSGi initializes, Buildship's `ProjectRegistryRefreshJob` finishes in 853 ms, then nothing. `PreferenceManager.getClientPreferences()` returns null on shutdown. Three debug cycles failed to find the subtle init-payload or framing mismatch causing it. Reverse-engineering jdtls 1.58's exact expectations remotely is the wrong shape of investment — `vscode-java`, [vscode.dev](https://vscode.dev), and Gitpod all hand jdtls messages it has known how to read for years, by going through `monaco-languageclient`. Doing the same makes the broken handshake a non-problem.

The reversal also dissolves M1's avoidance: M2 needed the `@codingame/monaco-vscode-api` ecosystem anyway, so keeping the bespoke TextMate adapter alongside it adds zero value while being one more place where a subtle bug can hide.

## Decision

Drop both bespoke runtimes. Adopt the standard `monaco-languageclient` + `@codingame/monaco-vscode-api` stack:

### Dependencies (`apps/web/package.json`)

- `monaco-languageclient: ~10.7.0` — the language client.
- `vscode-ws-jsonrpc: ~3.5.0` — WebSocket → JSON-RPC adapter (`toSocket`, `WebSocketMessageReader/Writer`).
- `vscode-languageclient: ~9.0.1` — peer of `monaco-languageclient`; pinned to whatever the client wants.
- `@codingame/monaco-vscode-api: ~25.1.2` and the family of service-overrides + extension packages, all pinned to `~25.1.2` (the version `monaco-languageclient@10.7.0` itself depends on; mismatched versions would dedupe two copies of `@codingame/monaco-vscode-api` and break the service registry at runtime).
  - `@codingame/monaco-vscode-editor-api`
  - `@codingame/monaco-vscode-textmate-service-override` (pulled in transitively by the api wrapper when `$type: 'extended'`)
  - `@codingame/monaco-vscode-theme-defaults-default-extension` — ships VS Code's Dark Modern theme contribution.
  - `@codingame/monaco-vscode-java-default-extension` — ships VS Code's Java grammar, snippets, and language-configuration. Does NOT ship a language server; that's still jdtls behind the WS.
- `vscode: npm:@codingame/monaco-vscode-extension-api@~25.1.2` — npm-aliased so `import * as vscode from 'vscode'` resolves to the API surface the extension packages expect.
- `monaco-editor: npm:@codingame/monaco-vscode-editor-api@~25.1.2` — npm-aliased so existing `import * as monaco from 'monaco-editor'` callsites in `main.ts` keep compiling without rewrites. The editor-api package re-exports the same surface Monaco's stock package does.

Removed: `monaco-editor` (real version), `vscode-jsonrpc`, `vscode-textmate`, `vscode-oniguruma`.

### Service initialization (`apps/web/src/monaco-setup.ts`)

Replaced with a `MonacoVscodeApiWrapper` configured with `$type: 'extended'`. The wrapper auto-registers textmate, theme, languages, model, and configuration services; we only supply:

- `viewsConfig: { $type: 'EditorService', htmlContainer }` — the simplest views config; tells the EditorService where editors render. `htmlContainer` is the `#editor` div.
- `userConfiguration.json: { 'workbench.colorTheme': 'Default Dark Modern', 'editor.fontSize': 14, 'editor.minimap.enabled': false, 'editor.experimental.asyncTokenization': true }` — selects the theme and base editor settings the way VS Code does.
- `monacoWorkerFactory: configureDefaultWorkerFactory` — the standard worker setup; replaces the hand-rolled `MonacoEnvironment.getWorker` shim.

Plus two side-effect imports for the bundled VS Code extensions:

```ts
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-java-default-extension";
```

`setupMonaco(htmlContainer)` is idempotent (cached promise) and **must be awaited before any `monaco.editor.*` API call**. `main.ts` does this immediately after locating the `#editor` div.

### Language client (`apps/web/src/lsp-setup.ts`)

Collapsed from ~432 lines to ~80. New shape:

```ts
const ws = new WebSocket(lspWebSocketUrl());
ws.addEventListener("open", () => {
  const socket = toSocket(ws);
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);
  const client = new MonacoLanguageClient({
    name: "FRC Java",
    clientOptions: {
      documentSelector: [{ language: "java" }],
      workspaceFolder: { index: 0, name: "project", uri: vscode.Uri.parse("file:///workspace/project") },
      errorHandler: { ... },
    },
    messageTransports: { reader, writer },
  });
  client.start();
});
```

The library handles `initialize` payload construction, `initialized` notification, document sync registration, completion/hover/diagnostics request routing, the lifecycle state machine, and graceful shutdown via `client.stop()`. The `ready` Promise resolves when `client.start()` resolves (initialize handshake completes). The 180s cold-start timeout from the bespoke adapter is gone; the library's own timeouts apply.

### Backend protocol contract: unchanged

The `/lsp` WebSocket still carries plain JSON-RPC, one message per text frame, no Content-Length headers. That's exactly what `vscode-ws-jsonrpc`'s `toSocket()` produces, so the backend's framing translator (`apps/server/src/main.ts:LspFrameParser`) and graceful-shutdown logic stay untouched. Decision 008's framing convention was right; only the browser-side adapter changed.

### Vite config (`apps/web/vite.config.ts`)

Two additions to support the @codingame ecosystem:

- `worker.format: 'es'` — monaco-vscode-api workers ship as ES modules.
- `optimizeDeps.esbuildOptions.target: 'esnext'` and `build.target: 'esnext'` — allows top-level await in the @codingame dep tree.

Proxy config for `/file`, `/health`, `/run`, `/lsp` is unchanged.

### Files removed

- `apps/web/src/textmate-setup.ts`
- `apps/web/src/grammars/` (the vendored `java.tmLanguage.json`)
- `apps/web/src/themes/` (the vendored `dark-modern.json`, `dark-plus.json`, `dark-vs.json`)

### `main.ts` deltas

- Drop `import { setupTextMate, THEME_NAME } from "./textmate-setup.js"`.
- Replace `setupMonaco(); await setupTextMate();` with `await setupMonaco(editorEl);`.
- Drop the `theme: THEME_NAME` editor option (theme is now set via `userConfiguration` in `setupMonaco`).
- Drop the `model` argument from `startLanguageClient(model)`. The MonacoLanguageClient discovers open models matching `documentSelector` automatically.
- Keep the `monaco.Uri.parse("file:///workspace/project/src/main/java/frc/robot/Robot.java")` line, the `monaco.editor.createModel(...)` and `monaco.editor.create(...)` calls, the lsp-loading → idle pill transition, the save flow, and the run flow — all unchanged. The `monaco-editor` npm-alias makes the `import * as monaco from "monaco-editor"` resolve to `@codingame/monaco-vscode-editor-api` transparently.

## Trade-offs

- **Bundle size.** ~1–2 MB gzipped growth from the @codingame ecosystem. Acceptable for a teaching IDE; the editor + LSP runtime is the dominant payload anyway, and AS Lite's wasm bundle already dwarfs it.
- **Transitive dep count.** ~30 new packages. Most are individual @codingame service-overrides and language-pack stubs that are tiny by themselves.
- **Less control over LSP wire protocol.** The library decides exactly what initialization options, capabilities, and notifications get sent. That's the entire point of the reversal — those are the messages jdtls is built to read.

## Verification

Same surface as decision 008:

- Editor renders with Dark Modern theme; `Robot.java` highlighting matches VS Code (keywords blue `#569CD6`, types teal `#4EC9B0`, strings orange `#CE9178`, defaults `#CCCCCC`).
- Status pill: `lsp-loading` → `idle` within 30–90 s on cold start; faster on warm. (`ready` now resolves when `initialize` completes, not when jdtls's `language/status: ServiceReady` fires — completions may briefly return empty during the Buildship import window. This is a small UX regression vs. the bespoke adapter; see "Future work" below.)
- Type `RobotB` → completion list includes `RobotBase`.
- Introduce `int x = "oops";` → red squiggle within ~1 s; remove the error → squiggle clears.
- Hover over `RobotBase` → javadoc tooltip.
- Run loop unaffected; AS Lite reconnects to NT4 on `:5810`.
- Close browser, reopen — converges back to `idle` cleanly. `docker exec frc-lsp-mvp pgrep -fa java` is empty after page close (backend graceful shutdown is unchanged).

## Future work

- If the brief `lsp-loading → idle` window before `ServiceReady` becomes a problem (users typing during the import gap and seeing empty completions), wire the pill transition off a custom notification handler for `language/status` instead of the `client.start()` Promise. The library exposes `client.onNotification("language/status", ...)` for this. ~10 lines.
- The library covers semantic tokens, code lens, signature help, refactoring actions, and inlay hints for free; if/when we want them, no more adapter glue is needed — they "just work" once jdtls is talking.
