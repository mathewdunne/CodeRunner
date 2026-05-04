# 002 — AdvantageScope Lite hosted standalone

**Status:** Implemented (Task 2 of MVP)
**Date:** 2026-04-30

## Context

Task 2 of `Project-MVP.md` requires building AdvantageScope Lite (AS Lite) from source, serving it locally, and having it auto-connect to the sim container's NT4 server from Task 1 (`localhost:5810`). The MVP spec flagged AS Lite NT4 endpoint configuration as the riskiest open question, with falling back to a custom minimal viz called out as an acceptable but undesirable outcome.

## Decisions

### AS Lite reads its NT4 hostname from `window.location.hostname` — no patching needed

Reading `vendor/AdvantageScope/src/hub/hub.ts` (~line 446) and `src/hub/dataSources/nt4/NT4.ts`:

- When the bundle is built with `ASCOPE_DISTRIBUTION=LITE`, the hub picks `window.location.hostname` as the live data source address.
- `NT4_PORTS_DEFAULT[0] = 5810` is hardcoded.
- `checkLiveAutoStart()` fires the connection without a user click.
- The `robotAddress` preference is ignored in Lite mode.

Implication: serving the Lite bundle from `http://localhost:8080` while the sim's NT4 server runs on `localhost:5810` produces a working connection with **zero source modifications, query params, or postMessage shims**. The spec's "configuration mechanism" is satisfied by the upstream distribution gating.

The same property is what makes the Task 3 iframe embedding cheap: an iframe loaded from `http://localhost:8080` sees `window.location.hostname === "localhost"`, regardless of the parent frame's origin. So a future frontend on `:3000` + AS Lite iframe on `:8080` + sim on `:5810` will coexist without cross-origin config.

We document this loudly in `README.md` so a future maintainer doesn't reintroduce a config layer that isn't needed.

### AdvantageScope as a git submodule pinned to a release tag

Path: `vendor/AdvantageScope`, pinned to `v26.0.2` (latest stable as of 2026-04-30; v27.x is in alpha). Per `Project-MVP.md` §Tech stack assumptions: "Use git submodules to include the AdvantageScope repository for building AS-lite." Pinning to a tag (rather than tracking `main`) keeps builds reproducible — upstream may rename the build script or change a flag we depend on at any time.

To upgrade later:

```bash
cd vendor/AdvantageScope
git fetch --tags
git checkout v26.0.X      # or the next stable
cd ../..
git add vendor/AdvantageScope && git commit -m "Bump AdvantageScope to vX.Y.Z"
npm run build:ascope      # rebuild
```

### Build and host outside the sim container

Building AS Lite shells out to AS's npm scripts (`compile`, `wasm:compile`) on the developer host, not inside any of our containers. The sim image stays focused on running headless WPILib. Reasons:

- AS Lite is a static asset bundle. Once built, only `dist/advantagescope/` matters at runtime — no Node, no Emscripten in the runtime path.
- Putting the AS build inside Docker would mean a multi-GB build container (Node + Emscripten + ~50 MB downloaded assets + ~1 GB AS dependencies) for a process that runs rarely (only on submodule bumps).
- The boring obvious option: install emsdk on the host once, document it, move on.

### Single root `package.json`, no workspaces yet

`Project-MVP.md` allows workspaces "if separating frontend and backend"; we have neither yet. Tasks 3 and 4 will likely justify workspaces — at that point we promote the root package to a workspace root. CLAUDE.md explicitly cautions against speculative workspace setup.

The root package depends on `tsx`, `typescript`, `fastify`, `@fastify/static`, plus type packages. Scripts run via `tsx` directly — no separate compile step. `tsconfig.json` uses `noEmit: true`; `npm run typecheck` runs `tsc --noEmit` for editor/CI feedback only.

### Fastify + `@fastify/static` for the static server, with two custom routes

`scripts/serve-ascope-lite.ts` hosts `dist/advantagescope/` on `:8080`. Plain HTTP — never HTTPS, because NT4 is `ws://` and a Lite page served over HTTPS would have its WebSocket blocked as mixed content.

`@fastify/static` serves the static bundle, but AS Lite also expects two dynamic-looking routes that the upstream `lite_server.py` provides (`vendor/AdvantageScope/lite/lite_server.py`):

- `GET /assets` (no trailing slash) — returns a JSON manifest of every file under `bundledAssets/`. Keys are relative paths like `Field2d_2026FRCFieldV1/config.json`; values are parsed JSON for `config.json` files and `null` for binary assets. AS Lite fetches this once at load time (`src/main/lite/assetLoader.ts`) and uses it to populate the field/robot picker.
- `GET /assets/<name>/<file>` — serves the actual asset file out of `bundledAssets/<name>/<file>`.

Without these routes, the page loads its UI but the field and robot 3D model lists are empty, and the browser logs `404 /assets`. The Fastify server registers both routes ahead of `@fastify/static` and walks `bundledAssets/` once at startup to cache the manifest. Rebuilding the manifest requires a server restart, which is fine — `bundledAssets/` only changes when the AS submodule bumps and the bundle is rebuilt.

Fastify (over `serve-handler`/Express) because Task 4's backend will probably also be Fastify; using the same toolkit avoids gratuitous churn now. If Task 4 picks something else we can swap then.

### Build script — flat imperative, not a proper task runner

`scripts/build-ascope-lite.ts` is straight-line `spawnSync` calls: sanity-check submodule → `npm install` in submodule → `compile` with `ASCOPE_DISTRIBUTION=LITE` → `wasm:compile` with emsdk on PATH → copy `lite/static/` into `dist/advantagescope/`. No build framework, no caching, no parallelism. Boring obvious option.

The script knows about emsdk in two places:

1. It defaults `EMSDK` to `D:/Documents/GitHub/emsdk` (the project author's machine) and lets contributors override via the `EMSDK` env var.
2. It prepends `$EMSDK` and `$EMSDK/upstream/emscripten` to `process.env.PATH` before spawning `npm run wasm:compile`. This avoids requiring contributors to source `emsdk_env.bat` in every shell.

### Wasm step kept in (not skipped)

`npm run wasm:compile` builds `hub$wpilogIndexer.{js,wasm}` for AS Lite's wpilog (log file) decoder. Live NT4 doesn't strictly need it, but skipping it leaves the bundle in an inconsistent state (the upstream `compile` script writes JS that imports the wasm at runtime). Cheaper to install Emscripten once than to maintain a "lite Lite" build variant.

## Issues encountered during implementation

### 1. `spawnSync(npmCmd, [...], { shell: false })` returns exit `null` on Windows

First run failed instantly with `Command failed (exit null): npm.cmd install`. On Windows, `spawn` cannot launch `.cmd` files unless `shell: true` is set (Node's documented behavior; see [DEP0190](https://nodejs.org/api/deprecations.html#DEP0190)). Fix: pass `shell: process.platform === "win32"` to `spawnSync`. Inputs are hardcoded literals in this script (not user-supplied), so the shell-quoting deprecation warning is benign.

### 2. AS Lite ships a `lite/static/` directory inside the submodule with `index.html` and `popups.css`

This caused initial confusion: those files exist before any build runs. They're upstream-checked-in HTML scaffolding; the rollup `compile` step writes JS bundles into `lite/static/bundles/`, and `wasm:compile` writes the wpilog wasm into the same place. The build is "merge-style" — pre-existing static files plus generated bundles together form the servable root.

We copy the whole `lite/static/` tree (post-build) into `dist/advantagescope/`, keeping the upstream layout untouched.

### 3. Git symlinks under `lite/static/` checked out as 9-byte text files on Windows

The AS repo has two symlinks under the Lite static tree:

- `lite/static/www` → `../../www` (resolves to `vendor/AdvantageScope/www/` — global.css, hub.html, all the per-tab HTML and CSS)
- `lite/static/docs/build` → `../../../docs/build` (only exists if `npm run docs:build-embed` ran; we don't)

Without git's `core.symlinks = true` (off by default on Windows unless Developer Mode is on), git checks symlinks out as plain text files containing the target path. The first build produced a `dist/advantagescope/www` that was a 9-byte file containing `../../www`, so AS Lite loaded with no styles and 404'd on every `www/*` asset.

Fix: `scripts/build-ascope-lite.ts` now queries `git ls-files -s lite/static` for entries with mode `120000` (symlinks), reads the target from the placeholder file, resolves it relative to the symlink's directory, and copies the real target into `dist/advantagescope/` after the initial `cpSync`. If the target doesn't exist (as with `docs/build` when docs haven't been built), the placeholder is removed and a warning is logged. This works the same way regardless of whether the host actually supports symlinks — we just always copy.

The alternative (`git config --global core.symlinks true` + Windows Developer Mode) would work for the project author but break for any contributor who hasn't done the same setup. The script-based fix is portable.

### 4. AS Lite expects `GET /assets` and `GET /assets/<name>/<file>` server routes

`@fastify/static` alone serves the static bundle but doesn't satisfy AS Lite's runtime asset loader. `src/main/lite/assetLoader.ts` calls `fetch("assets")` expecting a JSON manifest mapping every relative path under `bundledAssets/` to either its parsed `config.json` contents or `null` for binary files; subsequently each field/robot config's `path` is built as `assets/<name>/{image.png,model.glb}`. Without these routes, the UI loads but the field and robot pickers are empty.

Fix: register two custom routes in `serve-ascope-lite.ts` ahead of `@fastify/static`. The manifest is built once at startup by walking `bundledAssets/` and parsing every `config.json`. Path traversal is blocked by checking that the resolved absolute path stays under `bundledAssets/`. Mirrors `lite/lite_server.py`'s behavior — see the §"Fastify + `@fastify/static`" decision above.

### 5. AS submodule's `postinstall` is heavy

First `npm install` inside `vendor/AdvantageScope` runs:

- `cd docs && npm install` — ~828 packages
- `node getLicenses.mjs` — gathers licenses
- `node tesseractLangDownload.mjs` — downloads OCR language data
- `node bundleLiteAssets.mjs` — pulls ~50 MB of field/robot 3D models from the `Mechanical-Advantage/AdvantageScopeAssets` GitHub release `archive-v1`
- `npm run download-owlet` — downloads platform-specific Owlet binaries for 7 platforms

Total first-run time: ~5 minutes on a decent connection. Subsequent runs are no-ops because npm and the download scripts are idempotent. We do not skip `postinstall` because `bundleLiteAssets.mjs` is what populates `lite/static/bundledAssets/` (the field/robot models AS Lite renders).

### 6. AS upstream prints `npm audit` warnings about transitive vulns

Cosmetic only; AS's deps are theirs to manage. We don't pin any of their transitive deps. Ignored.

## Verification results

Run on 2026-04-30 against `frc-sim:mvp` and `dist/advantagescope/` from a fresh build:

- `npm run build:ascope`: ~6 min cold, dominated by the AS submodule's first `npm install` and `download-owlet`. Subsequent runs ~1 min (recompile only). Output `dist/advantagescope/` is 360 MB on disk — bundled assets and Owlet binaries dominate.
- `dist/advantagescope/bundles/hub.js` contains the strings `window.location.hostname` and `AdvantageScopeLite` — confirms the bundle was built with `ASCOPE_DISTRIBUTION=LITE`.
- `npm run serve:ascope`: Fastify listens on `127.0.0.1:8080` in <1 s. `curl http://localhost:8080/` returns HTTP 200. Manifest log line reports the asset count served from `bundledAssets/`.
- Raw NT4 WebSocket handshake (independent test, `ws` lib): connecting to `ws://localhost:5810/nt/AdvantageScopeLite` with subprotocol `v4.1.networktables.first.wpi.edu` succeeds against the running sim. Confirms the technical path AS Lite uses.
- Visual verification in Chrome at `http://localhost:8080` confirmed by user: AS Lite loads with no console errors after the symlink and `/assets` fixes; counter increments on a Line Graph tab; `Pose2d` moves in a circle on a 2D Field tab; hard reload reconnects automatically.

## Out of scope (deliberately)

- Embedding AS Lite inside another page — Task 3.
- Dynamic NT4 endpoint configuration. Per the §1 finding above, AS Lite hardcodes hostname/port at build time; that is fine for MVP. Multi-tenant routing post-MVP will need a different approach (see `Project-MVP.md` deferred items).
- Styling, theming, multi-server selection UI.
- Production deployment, TLS. (TLS would require a TLS-terminating proxy in front of NT4 too — `wss://` for the WebSocket to keep mixed-content rules happy. Post-MVP problem.)
