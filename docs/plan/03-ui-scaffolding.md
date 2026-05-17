# Plan 03 — UI scaffolding (Tailwind + shadcn/ui + modularize)

## Context

[apps/tmp_old_web/src/main.tsx](../../apps/tmp_old_web/src/main.tsx) (the old
web shell, preserved for reference) is **467 lines in a single `App()`
component**. State is scattered across ad-hoc `useState` hooks, styling is
plain CSS in `apps/tmp_old_web/src/style.css`, and there is no design system.
Before piling new student-facing features on (driver station, auth, importer,
admin), set the table.

**The shadcn/ui Vite scaffold has already been bootstrapped** in `apps/web/`.
The old source code is preserved at `apps/tmp_old_web/` for reference. Tasks
below pick up from that checkpoint.

This plan **does not change behavior**. It's a pure refactor that:

1. ~~Bootstraps `apps/web/` as a fresh shadcn/ui Vite app~~ — **done**.
2. Copies today's working UI behavior from `apps/tmp_old_web/` into the new
   scaffold.
3. Adds React Router 7 in SPA mode for routing, layouts, and navigation.
4. Decomposes `main.tsx` into a tree of focused components.
5. Extracts state into purpose-built hooks.

The visual baseline must match pre-refactor closely enough that a side-by-side
screenshot diff is unsurprising.

## Out of scope

- Replacing the Run/Stop buttons or `<pre>` console — see [Plan 04](04-driver-station.md).
- Replacing the username login form — see [Plan 05](05-auth-and-admin.md).
- Adding any admin UI — see [Plan 05](05-auth-and-admin.md).
- Adding the project importer dialog — see [Plan 06](06-project-importer.md).

## Design constraints

These rules apply to every file produced by this plan and all downstream plans.

- **shadcn components are mandatory.** Do not hand-roll raw form controls,
  dialogs, dropdowns, tooltips, or other interactive primitives when a shadcn
  component exists. Reach for `shadcn@latest add <component>` first.
- **Sonner via shadcn only.** Toast notifications use the `sonner` primitive
  added by the shadcn CLI (`bunx --bun shadcn@latest add sonner`). Do not
  wrap it in a custom toast abstraction or import `sonner` directly without
  going through the shadcn-generated component.
- **Zustand for client UI state only.** Zustand is the state container for
  ephemeral, client-only interaction state: selected item, active tab,
  panel/sidebar collapsed, dialog open/closed, drag state, temporary editor
  state, local UI preferences. Domain/server-derived state (session, run
  status, container status, scope status, editor reachability) lives in hooks
  with `useState`/`useReducer` and is passed via props or React context — it
  does not go into the Zustand store.
- **React Router 7 in SPA mode.** All routing, layouts, and navigation use
  React Router 7. No ad-hoc `window.location` parsing or conditional rendering
  for route-level concerns.
- **TypeScript strict.** `tsconfig.json` must have `"strict": true`. No `any`
  escapes except where a third-party type genuinely forces it (add a comment).

## Dependencies

[Plan 02](02-trim-tests-config.md) is helpful before this plan because it
removes the `"queued"` run state from the web shell, simplifying the state
extraction. Not strictly required.

## Tasks

### 1. Bootstrap shadcn — DONE

The shadcn/ui Vite scaffold is already in `apps/web/`. `components.json`
exists, `@/components/...` imports resolve, and the installer-generated
Tailwind setup is in place. The old source is at `apps/tmp_old_web/` for
reference.

The remaining tasks migrate behavior from `apps/tmp_old_web/src/main.tsx` into
the new component/hook/route structure. Prefer the scaffold's generated config
files over anything in `apps/tmp_old_web/` when they conflict.

### 2. Path aliases and config cleanup

- Confirm the installer configured `@/*` to point at `./src/*` in
  `apps/web/tsconfig.json` and `apps/web/vite.config.ts`.
- If the installer uses Tailwind v4, keep its `@import "tailwindcss";` style.
  Do not convert it back to v3-style `@tailwind base/components/utilities`.
- If the installer uses `@tailwindcss/vite`, keep the Vite plugin and do not add
  PostCSS/autoprefixer unless required by the generated scaffold.
- Port the CSS custom properties from `apps/tmp_old_web/src/style.css` (lines 1–6)
  into `apps/web/src/index.css` so the dark visual baseline remains close.

### 3. Install initial primitives

These primitives cover today's UI plus what Plans 04 and 05 will need:

```bash
bunx --bun shadcn@latest add button card dialog dropdown-menu tabs tooltip separator badge scroll-area resizable sonner
```

`<Resizable>` (a wrapper around `react-resizable-panels`) replaces today's
hand-rolled splitter logic.

`sonner` must be added via the shadcn CLI as shown above — do not `bun add
sonner` directly or wrap it in a custom toast abstraction. Mount the shadcn-
generated `<Toaster />` once at `App.tsx` root. Every error path in this plan
and downstream plans (build failed, container OOM, import rejected, allowlist
denied, etc.) goes through `toast.error(...)`. Establish this pattern here so
plans 04–07 don't reinvent it.

### 4. Add React Router 7

Install React Router 7:

```bash
bun add react-router
```

Use SPA mode (`createBrowserRouter` / `RouterProvider`). No server-side
rendering, no React Router framework mode.

Route layout:

| Path | Component | Notes |
|------|-----------|-------|
| `/u/:slug/` | `WorkspacePage` wrapped in `WorkspaceLayout` | IDE shell for one student workspace |
| `*` | redirect → `/u/:slug/` | fallback; slug comes from the proxy-injected URL |

`App.tsx` creates the router and mounts `<RouterProvider>`. The workspace slug
is read from the `:slug` route param (replacing today's `window.location`
parse at `apps/tmp_old_web/src/main.tsx:21–25`).

### 5. Decompose `main.tsx`

Target tree under `apps/web/src/`:

```
App.tsx                       # createBrowserRouter + RouterProvider, global providers, <Toaster />
main.tsx                      # Stays small: ReactDOM.render → <App />
index.css                     # Tailwind directives + global resets
lib/
  utils.ts                    # shadcn cn() helper
  contracts.ts                # Re-export / narrow types from @frc-coderunner/contracts
routes/
  WorkspaceLayout.tsx         # Layout route: session gate, Topbar, IDELayout shell
  WorkspacePage.tsx           # Renders EditorPane, ScopePane, ConsolePane, RunControls
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
  useSession.ts               # Session load + heartbeat (60s); returns session state locally
  useRunChannel.ts            # WebSocket client for /run channel (auto-reconnect)
  useContainerStatus.ts       # 5s polling; returns container state locally
  useEditorReachability.ts    # 10s probe; returns reachability locally
  useScopeHandshake.ts        # postMessage handshake to AS Lite iframe
state/
  store.ts                    # Zustand store — UI state only (see task 6)
```

**Migration rules:**

- Behavior must not change *except* where today's behavior is buggy and
  documented otherwise (the run-channel reconnect, see below).
- State variable names can be renamed but their semantics stay identical.
- The AS Lite postMessage handshake (`frc-sim:set-nt4-endpoint` send,
  `frc-sim:nt4-endpoint-ready` receive) must be preserved exactly. See
  [apps/tmp_old_web/src/main.tsx:295–347](../../apps/tmp_old_web/src/main.tsx) for the current implementation.
- The 80-line console buffer cap stays.
- Workspace slug is now read from the React Router `:slug` param, not parsed
  from `window.location` directly.
- Use shadcn components wherever a primitive exists. No hand-rolled `<input>`,
  `<button>`, `<select>`, or modal markup when a shadcn equivalent is available.

**Run-channel auto-reconnect (intentional behavior change).** Today
`apps/tmp_old_web/src/main.tsx:230` just logs "Run channel disconnected"
and gives up. `useRunChannel` should reconnect with exponential backoff
(start 500ms, cap 10s, reset on successful connect). On reconnect, refetch
run status via the existing HTTP status endpoint to resync state. The hook
exposes a `connection: "connected" | "reconnecting" | "disconnected"` value
so the topbar status pill can reflect it.

### 6. State extraction

**Two-layer state model:**

**Layer 1 — domain/server state → hooks with local `useState`.**
State that reflects server reality is owned by the hook that fetches or
subscribes to it. Hooks return values; components read them via props or
React context. Nothing domain-related goes into the Zustand store.

| Hook | State it owns |
|------|--------------|
| `useSession` | `{ status, user, workspaceSlug }` |
| `useRunChannel` | `{ runStatus, connection }` |
| `useContainerStatus` | `{ codeStatus, simStatus }` |
| `useEditorReachability` | `{ reachability }` |
| `useScopeHandshake` | `{ scopeStatus }` |

**Layer 2 — client UI state → Zustand store at `state/store.ts`.**
The Zustand store holds only ephemeral, client-only interaction state that has
no server equivalent and does not need to survive a page refresh:

- Active tab or selected item
- Panel / sidebar collapsed state
- Dialog open/closed
- Drag state
- Temporary editor UI state
- Local UI preferences (pane sizes cached in memory, not persisted)

Do not put session data, run status, container health, or any server-derived
value into the Zustand store.

Don't introduce Redux Toolkit — overkill.

### 7. Style cleanup

- Port resets, typography, and CSS custom properties from
  `apps/tmp_old_web/src/style.css` into `apps/web/src/index.css`.
- Do not create a new `style.css` in `apps/web/src/`. All global CSS lives in
  `index.css`; component-level styling uses Tailwind classes.
- The grid layout in the old `style.css` (`.app-shell`, `.topbar`,
  `.ide-grid`) is replaced by Tailwind classes on the new components.
- Custom-property color tokens (e.g., `var(--color-bg)`) resolve to
  the Tailwind theme colors instead.
- Verify the responsive media query (`@media (max-width: 900px)` hiding the
  scope pane) still works — re-implement with Tailwind responsive prefixes.

### 8. Editor iframe — passthrough

The editor iframe is opaque and should remain so. `EditorPane.tsx` just
renders an `<iframe>` with `src=/u/{slug}/vscode/?folder=/workspace/project`,
the existing `allow="clipboard-read; clipboard-write"` attributes, and a
loading skeleton from shadcn's primitives if you want one. No postMessage
needed.

### 9. AS Lite iframe — preserve handshake

`ScopePane.tsx` keeps the `useScopeHandshake` hook driving the postMessage
exchange. The iframe `src` stays `/scope/?frcEndpoint=postMessage`. The 10-second
ACK timeout is preserved. The hook exposes `scopeStatus` ("loading" |
"configured" | "connected" | "timeout") to the store.

## Files modified / created / deleted

**Already in place (from bootstrap):**
- `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`,
  `apps/web/index.html`, `apps/web/components.json`, `apps/web/src/index.css`,
  `apps/web/src/lib/utils.ts`, `apps/web/src/components/ui/*`

**Modified:**
- `apps/web/package.json` — add `react-router`, `zustand`
- `apps/web/src/index.css` — port global CSS from `apps/tmp_old_web/src/style.css`

**Created:**
- `apps/web/src/App.tsx` — router setup, global providers, `<Toaster />`
- `apps/web/src/lib/contracts.ts` — re-export / narrow types from `@frc-coderunner/contracts`
- `apps/web/src/routes/WorkspaceLayout.tsx`
- `apps/web/src/routes/WorkspacePage.tsx`
- `apps/web/src/components/{Topbar,IDELayout,EditorPane,ScopePane,ConsolePane,RunControls,StatusStrip}.tsx`
- `apps/web/src/hooks/{useSession,useRunChannel,useContainerStatus,useEditorReachability,useScopeHandshake}.ts`
- `apps/web/src/state/store.ts` — Zustand store for UI state only

**Modified (significantly):**
- `apps/web/src/main.tsx` — shrinks to ~10 lines (mount `<App />`)

**Not created:**
- `apps/web/src/style.css` — do not create; all global CSS stays in `index.css`

## Verification

1. `cd apps/web && bun run dev` — Vite dev server starts; no Tailwind compile
   errors.
2. Run `bun run dev:control` and visit `http://localhost:4000/u/<slug>/`.
3. Side-by-side visual diff against `apps/tmp_old_web/` baseline:
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
7. `bun run typecheck` green with `"strict": true` in `tsconfig.json`. No
   unexplained `any` types in new code.
8. The web build (`bun run build:web`) produces a working bundle.
9. Navigate to `/u/<slug>/` via the browser address bar — React Router picks up
   the slug param correctly without a full-page reload.
