# 005 - Java LSP MVP integration

**Status:** Implemented
**Date:** 2026-05-02

## Context

The MVP editor originally used Monaco's built-in Java syntax highlighting only. The Java LSP add-on gives the single hardcoded `Robot.java` buffer hover, completion, and diagnostics for WPILib code while preserving the existing save/run/AdvantageScope loop.

The previous attempt failed mostly in the browser integration: Vite pre-bundled VS Code extension packages in a way that broke adjacent `resources/` URL lookups. The restart deliberately follows TypeFox's Eclipse JDT LS example shape more closely.

## Decisions

### Plain Monaco client with direct LSP requests

The first retry used TypeFox's `MonacoVscodeApiWrapper`, `EditorApp`, and `LanguageClientWrapper` because that matched the upstream example. It connected, but browser behavior was still unreliable: some project diagnostics appeared, while the live editor buffer did not consistently drive Java diagnostics/completions.

The MVP now keeps plain `monaco-editor` and adds a small direct LSP adapter in `apps/web/src/java-lsp.ts`. It opens `file:///workspace/project/src/main/java/frc/robot/Robot.java`, sends `initialize`, `didOpen`, and full-text `didChange`, and registers Monaco hover, completion, and diagnostics providers backed by JDT LS requests/notifications.

The app still loads the file through `GET /file`, auto-saves through `POST /file`, and runs through `WS /run`. LSP is attached to the active browser model; the sim container remains the source of truth for execution.

Follow-up: the adapter also advertises `textDocument.semanticTokens` support and registers a Monaco document semantic tokens provider when JDT LS returns a `semanticTokensProvider` capability. This lets Monaco color Java identifiers by resolved symbol kind instead of relying only on Monaco's basic Java tokenizer.

### Local WPILib-aware JDT LS image

The LSP server runs in `frc-lsp:mvp`, separate from the sim container. The image installs Eclipse JDT LS and copies the same baked Gradle project from `containers/sim/project` into `/workspace/project`, then runs `./gradlew build` during image build. This primes Gradle/WPILib dependencies so JDT LS can resolve FRC symbols without waiting for the student's first edit/run.

The Node bridge in `apps/lsp` exposes `ws://localhost:30003/jdtls` and spawns `java` with the standard JDT LS launch arguments from TypeFox's example. `npm run dev:mvp` ensures `frc-lsp-mvp` is running next to `frc-sim-mvp`.

### Package and Vite choices

`apps/web` intentionally uses plain `monaco-editor@0.52.2` again. The TypeFox/Codingame VS Code compatibility packages were removed from the browser because they made the MVP editor harder to debug than the small LSP surface we need right now.

Vite uses ES workers and `esnext` build target. No VSIX plugin or cross-origin isolation headers are used.

Cross-origin isolation headers were deliberately left off the Vite dev server because this app embeds AdvantageScope Lite from `http://localhost:8080` in an iframe. Adding `Cross-Origin-Embedder-Policy` caused Chrome to reject that iframe even though the editor itself loaded.

## Verification

Static verification:

- `npm install`
- `npm run typecheck`
- `npm run typecheck --workspace apps/server`
- `npm run typecheck --workspace apps/web`
- `npm run typecheck --workspace apps/lsp`

Manual verification:

- Build `frc-sim:mvp` and `frc-lsp:mvp`.
- Run `npm run dev:mvp`.
- Open `http://localhost:3000`.
- Confirm no extension resource 404s and no "Monaco did not create a model" error.
- Confirm the console reports `java language server connected`.
- Hover WPILib symbols, request completions after `SmartDashboard.`, and introduce/fix a Java error to confirm diagnostics.
- Confirm edit/save/run still streams logs and AS Lite reconnects to updated NT4 data.
