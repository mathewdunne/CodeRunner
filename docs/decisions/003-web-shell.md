# 003 — Minimal web shell

**Status:** Implemented (Task 3 of MVP)
**Date:** 2026-04-30

## Context

Task 3 of `Project-MVP.md` builds the single-page browser app that students will eventually use as their IDE: Monaco editor on the left, AdvantageScope Lite embedded on the right, a console pane and Run button along the bottom. Per the spec the Run button is a no-op that logs `"clicked"` and the file is loaded via static fetch — backend wiring (file save, build trigger, log streaming) is Task 4.

## Decisions

### Vanilla TypeScript + Vite, no framework

`Project-MVP.md` §Tech stack assumptions explicitly allows "Vanilla TS with Vite" and notes the frontend "will likely be rewritten after MVP, so do not over-invest." The page is one screen with three regions: editor, scope, console+run. React/Vue/Svelte would each add a build-graph node and a learning surface for zero benefit at this scale. The boring obvious option wins.

The Vite dev server runs on **port 3000**, matching `Project-MVP.md` §Overall MVP definition of done. `server.strictPort = true` so a port collision fails fast instead of silently moving to 3001 and breaking the AS Lite iframe assumption.

### Workspace promotion: `apps/web/` under npm workspaces

`CLAUDE.md` already pre-committed to "promote to workspaces when Task 3 lands." Done now: root `package.json` adds `"workspaces": ["apps/*"]` and `"dev:web": "npm run dev --workspace apps/web"`. Existing root scripts (`build:ascope`, `serve:ascope`, `typecheck`) stay at the root because `scripts/serve-ascope-lite.ts` and `scripts/build-ascope-lite.ts` are root-level concerns operating on `vendor/` and `dist/`. The web shell's tsconfig is independent (DOM lib, `module: esnext`, `moduleResolution: bundler`) so it doesn't pollute the root scripts' typecheck.

Task 4 will add `apps/server/` (or similar) and possibly a shared `types.ts` package — the workspace setup is ready for that.

### AS Lite via iframe to `http://localhost:8080`, not bundled

Decision 002 already proved AS Lite reads `window.location.hostname` for its NT4 endpoint when built with `ASCOPE_DISTRIBUTION=LITE`. An iframe loaded from `http://localhost:8080` therefore connects to `ws://localhost:5810` automatically — **zero cross-origin config, no postMessage, no query params**. The iframe also sandboxes AS Lite's WebGL/wasm/asset loading from the host page.

Alternatives considered and rejected:

- **Vite proxy `/ascope/*` → `:8080`**: same-origin would be tidier, but AS Lite's `GET /assets` manifest route (decision 002 §"Fastify + `@fastify/static`") would need rewriting through the proxy, and the iframe approach is already proven.
- **Bundle `dist/advantagescope/` into the web app's static output**: tightly couples build pipelines, bloats the dev server with ~360 MB of assets per Vite cold start, and conflicts with Task 3's "AS Lite still standalone" wording. Explicitly out of scope.

The user runs `npm run serve:ascope` and `npm run dev:web` in two terminals during dev. The plan to consolidate via a single `docker compose up` is post-MVP per §Overall MVP DoD step 1.

### Monaco via npm + Vite `?worker` imports

`monaco-editor` is loaded as a regular npm dep, not from a CDN. Workers are wired via Vite's built-in `?worker` syntax: `import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"` and an assignment to `self.MonacoEnvironment` in `apps/web/src/monaco-setup.ts`. No `vite-plugin-monaco-editor` plugin needed — the `?worker` shorthand handles bundling and URL generation natively.

Java has no language-specific worker shipped by Monaco — it has a Monarch-based syntax-highlighting tokenizer that runs on the main thread. So only the default editor worker is registered. JSON/TS/CSS/HTML workers are intentionally not wired up; they'd add ~MB of bundle for no benefit in this single-language editor. They can be added later if a feature needs them.

### Robot.java duplicated as a static placeholder, with cross-pointers

`apps/web/public/Robot.java` is a verbatim copy of `containers/sim/project/src/main/java/frc/robot/Robot.java`. Both files start with a comment pointing at the other so the duplication is intentional and traceable. Task 4 deletes the static copy and makes Monaco fetch the live file via `GET /file` (a backend route that `cat`s out of the running sim container) — at that point the container's copy becomes the sole source of truth.

This was preferred over committing only the container copy and `fetch`-ing it from `containers/sim/...` at dev time because:

- Vite's `public/` directory has well-defined static-fetch semantics; reaching across the repo into a Java source tree from the browser is fragile.
- The duplication is short-lived (one task) and the pointer comments make intent obvious.

### Layout: CSS grid; AS Lite spans the full right column, console sits only under the editor

Two columns at 1:1, two rows at `1fr / 220px`. Grid template areas are:

```
"editor       scope"
"console-row  scope"
```

so `#scope` (the AS Lite iframe) spans both rows on the right while `#console-row` (scrolling log + Run button) sits only under `#editor`. First pass had the console row spanning full width — that clipped AS Lite's `--tab-controls-height: 200px` panel (defined in `vendor/AdvantageScope/.../hub.css`, pinned to the bottom of AS Lite's viewport) because the iframe lost ~220px of height. Letting AS Lite occupy the full right-column height (~1072px on a 1080p display) gives it enough room for its title bar, tab bar, timeline, content area, and the 200px controls panel without clipping. This split is also more semantic: the console shows editor/build/run output (an editor concern), AS Lite shows live telemetry (a sim concern); they don't need to share vertical real estate.

`automaticLayout: true` on Monaco's editor handles container resize via `ResizeObserver`. iframe is `width:100%; height:100%; border:0`.

## Issues encountered during implementation

### 1. Headless preview screenshot hangs when AS Lite iframe is loading

Took a screenshot via Claude's preview tool with the AS Lite iframe pointing at `http://localhost:8080`; the screenshot path timed out repeatedly even after the page finished loading (`document.readyState === "complete"`, eval responsive). Removing the iframe via JS did not unstick the renderer. Likely cause: AS Lite's WebGL/wasm asset loading + NT4 reconnect retries (no sim was running) saturate the headless renderer's compositor queue.

This is a verification-tool quirk, not a code bug. Real Chrome rendered the page correctly (verified by the user during dev). Verification fell back to:

- DOM bounding-box inspection (editor 952×846 left, scope 952×846 right, console-row 1912×220 bottom on 1920×1080).
- `fetch("/Robot.java")` returns 200 + 1808 bytes containing the placeholder header.
- Programmatic click on `#run` results in `[HH:MM:SS] clicked` appearing in `#console`.
- Console error logs empty across page lifecycle.
- `npm run typecheck` and `npm run typecheck --workspace apps/web` both succeed.

Future task: when wiring up automated UI tests, run them against a sim-on stack so AS Lite's connect-retry storm doesn't dominate.

### 2. Orphaned Vite child after `TaskStop` on the npm wrapper

Killing the `npm run dev:web` background task left the underlying `vite` Node process alive holding port 3000, blocking the next dev-server start. Resolved by killing the PID owning the port directly. Not a code issue — npm/Windows process-tree cleanup quirk.

### 3. `WARNING:StorageManager: settings timeout, using defaults` in the console

Reported during initial verification. The string does not appear in any AS Lite source or built bundle (verified with `grep -r` over both `vendor/AdvantageScope/` and `dist/advantagescope/`), nor in our own code. The `WARNING:component:` prefix matches Chromium's internal browser-process logger; this is the StorageManager subsystem (Quota / Persistent Storage API plumbing) reporting that loading its settings file timed out and defaults were used. Benign and unrelated to the app. Safe to ignore.

### 4. AS Lite tab-controls panel was clipped (initial layout)

First-cut layout used `grid-template-areas: "editor scope" / "console-row console-row"` — console row spans full width, AS Lite occupies only the top row. AS Lite's `--tab-controls-height: 200px` panel is positioned at the bottom of its own viewport (`vendor/AdvantageScope/www/hub.css` `div.controls-content { position: absolute; height: var(--tab-controls-height) }`); when our iframe was ~226 px shorter (lost to the shared bottom row), AS Lite's body height shrank with it but the controls panel positioned itself relative to the (smaller) viewport bottom, which on a 1080 p display put the panel close to the iframe edge — and the visible chrome (timeline, side bar) ate enough additional pixels that the controls panel clipped at the iframe boundary. Fix: change the template areas to `"editor scope" / "console-row scope"` so AS Lite gets the full right-column height. Documented above under §Layout.

## Verification results

Run on 2026-04-30 against `apps/web/` and `dist/advantagescope/` from a fresh build, with sim Docker container and `serve:ascope` running:

- `npm install` from repo root: 9 s, 64 new packages added (monaco-editor, vite, plus transitives) into the workspace.
- `npm run typecheck`: passes (root `scripts/`).
- `npm run typecheck --workspace apps/web`: passes (web shell, strict + `noUncheckedIndexedAccess`).
- `npm run dev:web`: Vite v6 ready in ~600 ms on `http://localhost:3000`.
- `curl http://localhost:3000/`: 200; `curl /src/main.ts`: 200 (transformed by Vite); `curl /Robot.java`: 200, 1808 bytes.
- DOM: Monaco editor mounts (`.monaco-editor` with `data-uri="inmemory://model/1"`, `vs-dark` theme), `#run` click appends `[HH:MM:SS] clicked` to `#console`, no console errors.
- Visual verification (real Chrome) confirmed by user: editor shows `Robot.java` with Java syntax highlighting, AS Lite iframe loads and connects to sim, counter and pose visible.

## Out of scope (deliberately)

- Backend wiring: file save / build trigger / log streaming — Task 4.
- Stop button, status indicators beyond a console line.
- Multiple files / file tree / tabs.
- Styling polish, theming, responsive layout.
- Bundling AS Lite into the web app or proxying it through Vite.
- Production build of the web app (`vite build`) — script is wired but unused at MVP stage.
