# Plan 03 — UI scaffolding (Tailwind + shadcn/ui + modularize)

## Context

[apps/web/src/main.tsx](../../apps/web/src/main.tsx) is **467 lines in a single `App()`
component**. State is scattered across ad-hoc `useState` hooks, styling is
plain CSS in [apps/web/src/style.css](../../apps/web/src/style.css), and there is no design system. Before
piling new student-facing features on (driver station, auth, importer,
admin), set the table.

This plan **does not change behavior**. It's a pure refactor that:

1. Bootstraps `apps/web/` as a fresh shadcn/ui Vite app with the current
   installer.
2. Copies today's working UI behavior into that scaffold instead of hand-wiring
   Tailwind.
3. Decomposes `main.tsx` into a tree of focused components.
4. Extracts state into purpose-built hooks.

The visual baseline must match pre-refactor closely enough that a side-by-side
screenshot diff is unsurprising.

## Out of scope

- Replacing the Run/Stop buttons or `<pre>` console — see [Plan 04](04-driver-station.md).
- Replacing the username login form — see [Plan 05](05-auth-and-admin.md).
- Adding any admin UI — see [Plan 05](05-auth-and-admin.md).
- Adding the project importer dialog — see [Plan 06](06-project-importer.md).

## Dependencies

[Plan 02](02-trim-tests-config.md) is helpful before this plan because it
removes the `"queued"` run state from the web shell, simplifying the state
extraction. Not strictly required.

## Tasks

### 1. Bootstrap shadcn first

Use the installer as the source of truth for current Tailwind/shadcn/Vite setup.
Do not hand-roll Tailwind config unless the installer leaves a small repo-local
gap.

- Preserve the current web shell for reference:
  - Copy `apps/web/src/main.tsx`, `apps/web/src/style.css`,
    `apps/web/package.json`, `apps/web/tsconfig.json`, and
    `apps/web/vite.config.ts` to a temporary backup outside `apps/web/` (for
    example `/tmp/frc-web-pre-shadcn/`).
- From `apps/web/`, run:
  ```bash
  bunx --bun shadcn@latest init
  ```
- Configure:
  - Template/framework: Vite + React + TypeScript, if prompted.
  - Style: New York.
  - Base color: Slate.
  - CSS variables: Yes.
  - Package manager/runtime: Bun.
- Let the installer create or update the Tailwind, Vite, alias,
  `components.json`, `src/index.css`, and `src/lib/utils.ts` setup it expects.
- After the scaffold exists, copy today's UI behavior from the temporary backup
  into the new `App.tsx`/component structure. Prefer the generated scaffold's
  config files over the old app's config when they conflict.

**Acceptance:** `apps/web/components.json` exists, the app builds with the
installer-generated Tailwind setup, and `@/components/...` imports resolve.

### 2. Path aliases and config cleanup

- Confirm the installer configured `@/*` to point at `./src/*` in
  `apps/web/tsconfig.json` and `apps/web/vite.config.ts`.
- If the installer uses Tailwind v4, keep its `@import "tailwindcss";` style.
  Do not convert it back to v3-style `@tailwind base/components/utilities`.
- If the installer uses `@tailwindcss/vite`, keep the Vite plugin and do not add
  PostCSS/autoprefixer unless required by the generated scaffold.
- Port today's CSS custom properties from [apps/web/src/style.css:1–6](../../apps/web/src/style.css)
  into the generated theme/global CSS so the dark visual baseline remains close.

### 3. Install initial primitives

These primitives cover today's UI plus what Plans 04 and 05 will need:

```bash
bunx --bun shadcn@latest add button card dialog dropdown-menu tabs tooltip separator badge scroll-area resizable sonner
```

`<Resizable>` (a wrapper around `react-resizable-panels`) replaces today's
hand-rolled splitter logic.

`sonner` is the toast primitive shadcn ships. Mount the `<Toaster />` once at
`App.tsx` root. Every error path in this plan and downstream plans
(build failed, container OOM, import rejected, allowlist denied, etc.) goes
through `toast.error(...)` rather than ad-hoc UI. Establish this pattern here
so plans 04–07 don't reinvent it.

### 4. Decompose `main.tsx`

Target tree under `apps/web/src/`:

```
App.tsx                       # Top-level layout shell, providers
main.tsx                      # Stays small: ReactDOM.render → <App />
index.css                     # Tailwind directives + global resets
lib/
  utils.ts                    # shadcn cn() helper
  contracts.ts                # Re-export / narrow types from @frc-sim/contracts
components/
  Topbar.tsx                  # User/workspace label, status pills, logout
  IDELayout.tsx               # Three-pane shell with <Resizable>
  EditorPane.tsx              # Editor iframe + reachability probe
  ScopePane.tsx               # AS Lite iframe + postMessage handshake
  ConsolePane.tsx             # <pre> log view (Plan 04 replaces this)
  RunControls.tsx             # Run/Stop buttons (Plan 04 replaces this)
  StatusStrip.tsx             # Connection/sim/scope/editor pills
  ui/                         # shadcn-generated primitives
hooks/
  useSession.ts               # Session load + heartbeat (60s)
  useRunChannel.ts            # WebSocket client for /run channel (auto-reconnect)
  useContainerStatus.ts       # 5s polling
  useEditorReachability.ts    # 10s probe
  useScopeHandshake.ts        # postMessage handshake to AS Lite iframe
state/
  store.ts                    # Cross-cutting state (see task 6)
```

**Migration rules:**

- Behavior must not change *except* where today's behavior is buggy and
  documented otherwise (the run-channel reconnect, see below).
- State variable names can be renamed but their semantics stay identical.
- The AS Lite postMessage handshake (`frc-sim:set-nt4-endpoint` send,
  `frc-sim:nt4-endpoint-ready` receive) must be preserved exactly. See
  [apps/web/src/main.tsx:295–347](../../apps/web/src/main.tsx) for the current implementation.
- The 80-line console buffer cap stays.
- Workspace slug extraction from the URL (`apps/web/src/main.tsx:21–25`) stays
  the same.

**Run-channel auto-reconnect (intentional behavior change).** Today
[main.tsx:230](../../apps/web/src/main.tsx) just logs "Run channel disconnected"
and gives up. `useRunChannel` should reconnect with exponential backoff
(start 500ms, cap 10s, reset on successful connect). On reconnect, refetch
run status via the existing HTTP status endpoint to resync state. The hook
exposes a `connection: "connected" | "reconnecting" | "disconnected"` value
so the topbar status pill can reflect it.

### 5. State extraction

Pick one cross-cutting state container. **Recommendation:** Zustand. Single
store at `apps/web/src/state/store.ts` with slices:

- `session`: `{ status, user, workspaceSlug }` + `loadSession()`
- `run`: `{ status, queueInfo? }` (queueInfo is removed in Plan 02; if running
  this plan first, it can stay temporarily)
- `containers`: `{ codeStatus, simStatus }`
- `editor`: `{ reachability }`
- `scope`: `{ status }`

Hooks read from the store and own side effects (polling, websocket wiring).
Components are presentational where possible.

If Zustand feels heavy for the surface area, plain React Context with a
`useReducer` is acceptable. Don't introduce Redux Toolkit — overkill.

### 6. Style cleanup

- Move resets and typography from `apps/web/src/style.css` to
  `apps/web/src/index.css`.
- Delete `style.css` once all selectors have either moved to Tailwind classes
  or to `index.css` global rules.
- The grid layout currently lives in `style.css` (`.app-shell`, `.topbar`,
  `.ide-grid`). Replace with Tailwind classes on the new components.
- Custom-property color tokens (e.g., `var(--color-bg)`) should resolve to
  the Tailwind theme colors instead.
- Verify the responsive media query (`@media (max-width: 900px)` hiding the
  scope pane) still works — re-implement with Tailwind responsive prefixes.

### 7. Editor iframe — passthrough

The editor iframe is opaque and should remain so. `EditorPane.tsx` just
renders an `<iframe>` with `src=/u/{slug}/vscode/?folder=/workspace/project`,
the existing `allow="clipboard-read; clipboard-write"` attributes, and a
loading skeleton from shadcn's primitives if you want one. No postMessage
needed.

### 8. AS Lite iframe — preserve handshake

`ScopePane.tsx` keeps the `useScopeHandshake` hook driving the postMessage
exchange. The iframe `src` stays `/scope/?frcEndpoint=postMessage`. The 10-second
ACK timeout is preserved. The hook exposes `scopeStatus` ("loading" |
"configured" | "connected" | "timeout") to the store.

## Files modified / created / deleted

**Modified:**
- `apps/web/package.json` (Tailwind, shadcn deps)
- `apps/web/tsconfig.json` (path alias)
- `apps/web/vite.config.ts` (path alias)
- `apps/web/index.html` (no change expected, but verify)

**Created:**
- Installer-generated Tailwind/shadcn config files as applicable
  (`apps/web/components.json`, `apps/web/src/index.css`, and any generated
  Vite/Tailwind config the current installer requires)
- `apps/web/src/App.tsx`
- `apps/web/src/lib/utils.ts`
- `apps/web/src/components/{Topbar,IDELayout,EditorPane,ScopePane,ConsolePane,RunControls,StatusStrip}.tsx`
- `apps/web/src/components/ui/*` (shadcn-generated primitives)
- `apps/web/src/hooks/{useSession,useRunChannel,useContainerStatus,useEditorReachability,useScopeHandshake}.ts`
- `apps/web/src/state/store.ts`

**Deleted:**
- `apps/web/src/style.css` (after all rules migrated)

**Modified (significantly):**
- `apps/web/src/main.tsx` — shrinks to ~10 lines (mount `<App />`)

## Verification

1. `cd apps/web && bun run dev` — Vite dev server starts; no Tailwind compile
   errors.
2. Run `bun run dev:control` and visit `http://localhost:4000/u/<slug>/`.
3. Side-by-side visual diff against pre-refactor (use the
   `mcp__Claude_Preview__preview_screenshot` tool before and after):
   - Topbar layout matches.
   - Three-pane grid (editor | scope, with console at bottom) matches.
   - Splitters drag horizontally and vertically.
   - Status pills show the same states with similar colors.
4. Functional smoke:
   - Log in.
   - Editor iframe loads.
   - Run a build → console pane shows logs.
   - Stop run → status returns to idle.
   - AS Lite connects (`scopeStatus === "connected"`).
   - 60s heartbeat continues to fire (verify in network tab).
   - 5s container-status poll continues.
5. Use `mcp__Claude_Preview__preview_console_logs` to confirm no React
   warnings, no shadcn theming warnings, no CSS load failures.
6. Resize the browser to <900px width — scope pane hides as it did before.
7. `bun run typecheck` green.
8. The web build (`bun run build:web`) produces a working bundle.
