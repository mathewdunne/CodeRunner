# Project Preview implementation plan

Status: proposed; implementation has not started.

## Goal and agreed UX

Let students read project Markdown and generated HTML reports beside VSCodium without depending on VSCodium's preview or a runtime CDN.

- Keep the existing topbar toggle in its current position and preserve its pill styling. Add **Preview** after AdvantageScope and PathPlanner, using `FileText` from the already-installed `lucide-react` package. Use a decorative icon and a visible text label.
- Display Preview in the existing resizable right pane. Do not add another permanent pane or move the selector into the pane.
- Give Preview a compact toolbar containing a searchable document picker and a visible **Refresh** button (`RefreshCw`). Reserve space above the content for this toolbar; only the open picker menu overlays content.
- Show the filename and project-relative path in search results so repeated names such as `index.html` are distinguishable. Keep the selected path accessible in the closed toolbar, with truncation only for display.
- On first opening Preview for a project, select the root `README.md`, case-insensitively, when present. Otherwise show the picker and an instruction to choose a document; do not automatically open a license or an arbitrary report.
- Keep the selected entry while switching between the three views. Preserve the existing mounted AdvantageScope and PathPlanner instances. Do not introduce scroll-position storage or restoration.
- **Refresh reloads both the document list and the selected document from disk.** It recreates the iframe and starts the document at the top. It must also pick up changed CSS, images, and scripts. No auto-refresh, watchers, polling, or automatic view changes after a run.
- If the selected file disappears, clear its preview and say that the file is no longer available. Keep the refreshed picker usable. If no documents exist, show “No Markdown or HTML files found. Add a document or generate a report, then refresh.”
- Switching/resetting a project or importing a repository clears the old file selection and content, cancels stale requests, and loads the new project's list when Preview is next visible. Selection need not survive a full browser reload.

The picker identifies the selected entry document. Links inside an HTML report can navigate within its iframe; Refresh reopens the selected entry document, including when the reader has navigated to a report subpage. This avoids a cross-frame navigation bridge in the first version.

## Scope boundary

Include `.md`, `.html`, and `.htm` files, matching extensions case-insensitively. The picker is a file opener, not a second project explorer. Include generated output such as `build/reports/**`, even when gitignored. Do not use `.gitignore` as the discovery filter.

Exclude `.git`, `.gradle`, and `node_modules` directory trees from discovery and serving, and reject symlinks. Do not blanket-exclude hidden directories: project-authored documentation in another hidden directory remains eligible. Apply explicit traversal/read budgets and disclose incomplete results instead of silently claiming to list everything.

Defer VSCodium context-menu integration, multiple document tabs, a separate-window action, editing, automatic report detection after runs, scroll restoration, and a new mobile layout. The first version targets the existing desktop right-pane layout; its current 901px visibility breakpoint remains applicable.

**Planning assumption:** Preview should also work in plain-Java lessons, because their instructions and test reports are useful without simulation. Those lessons currently hide all right-pane and Driver Station UI. For them, put a Preview show/hide action at the existing topbar selector location, reveal only the right Preview pane on demand, and retain the editor's Run hint. Do not start simulation hooks or show AS, PP, or Driver Station for these lessons. This is a proposed scope extension, not an explicitly confirmed user requirement. If the user chooses the existing three-pane layout only, omit this extension and its tests; the rest of the plan is unchanged.

## Existing integration points

Inspected against repository HEAD `004d710`. The graph report was read for navigation; its recorded commit is older, so the current source is authoritative.

- `apps/web/src/components/SimPaneSwitcher.tsx` owns the `scope | pathplanner` values, session-stored view choice, topbar selector, and mounted panels. Extend this surface rather than building a separate navigation mechanism.
- `apps/web/src/components/Topbar.tsx` places the selector immediately before Switch project. Its location stays unchanged.
- `apps/web/src/routes/WorkspacePage.tsx` supplies the workspace slug and increments `reloadNonce` after project replacement. Reuse that invalidation for Preview. Preview uses `workspaceSlug`, not the simulation-only `simSlug`.
- `apps/web/src/components/IDELayout.tsx` owns pane resizing and currently combines right-pane and Driver Station visibility in `showSimPanels`. Separate those concerns only if implementing the plain-Java extension.
- `apps/control/src/app/workspace-routes.ts` already performs `requireWorkspaceOwnership` before dispatching workspace APIs. `auth.workspace.project_path` identifies the project directory visible to the control plane.
- `apps/control/src/app/deploy-files.ts` contains relevant path-containment and descriptor-check patterns, but its API is scoped to PathPlanner deploy files. Add a separate read-only Preview handler; do not broaden deploy-files permissions.
- `packages/contracts/src/index.ts` is the home for shared schemas. `apps/control/src/metrics.ts` templates route labels; preview filenames must not become metric labels.

## Rendering and API design

Use the Bun control plane to list and read project files directly. This needs no VSCodium extension changes, new per-student server, published container port, or running simulator.

Proposed authenticated routes:

| Route | Behavior |
| --- | --- |
| `GET /u/:slug/api/preview/documents` | Return `{ ok: true, documents: [{ path, kind }], truncated }`, with `kind` equal to `markdown` or `html`. Paths are relative to the project root; do not return file contents or host paths. |
| `GET /u/:slug/api/preview/files/<path>` | Render Markdown as HTML, serve HTML documents, or serve an allowed local report asset with the correct MIME type. Keep the project-relative directory hierarchy in the URL. |

Both routes, including every asset and linked page request, use existing session-cookie ownership checks. Unauthenticated API requests return an auth error rather than a login page embedded as a document. Only GET is supported initially; reject mutation methods.

Serve Markdown through a renderer bundled with the control application, with local CSS and system fonts. Use `markdown-it`, installed with Bun and committed in the lockfile; confirm its version and TypeScript support at implementation time. Support headings, lists, fenced code, tables, links, and local images. Keep raw embedded HTML disabled initially and document that limit. Add stable heading anchors so intra-document links work. No CDN-based renderer, fonts, syntax highlighting, or plugins are required. The library's [official documentation](https://github.com/markdown-it/markdown-it) describes its parser API and configurable syntax.

Preserve HTML reports' own markup and styling rather than applying Markdown styling to them. Support relative links between report pages and local CSS, classic JavaScript, and images, including references to parent directories that remain inside the project. Keep fragments and query strings intact. Explicitly handle URL encoding for spaces, Unicode, `#`, and `%` in filenames. Reject paths that escape the project; do not reinterpret arbitrary root-relative app URLs as project paths.

The initial compatibility target is a generated Gradle test report and ordinary static HTML, not arbitrary web applications. Reports requiring remote CDNs, backend APIs, ES modules with cross-origin requirements, or browser storage may need later compatibility work. Markdown should work with external requests blocked; externally hosted images and resources are not made offline by this feature.

### Isolation and bounded reads

Project HTML is executable student-controlled content. Use an iframe sandbox with `allow-scripts` for report interactivity and **without `allow-same-origin`**. Apply the sandbox policy in HTTP response headers as well, so opening a raw report URL does not bypass isolation. Markdown documents do not need script execution. MDN documents both the [iframe sandbox restrictions](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) and the [HTTP CSP sandbox directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).

Restrict resource loading to the authenticated preview resource namespace and explicitly permitted data images; allow the inline styles/scripts needed for static reports. Block network API connections, forms, workers, nested frames, automatic popups, and top-level navigation. Do not grant general app-origin script access or credentialed CORS for opaque origins. Use `nosniff`, `Referrer-Policy: no-referrer`, and private `no-store` responses for the list, rendered documents, and local assets. Apply document isolation to directly navigable SVG assets too. Check compatibility with the app's existing security-header wrapper rather than weakening global headers.

Use a narrow MIME allowlist for report assets, initially CSS, classic JS, common images including SVG, and fonts as demonstrated by the compatibility fixture. Do not expose arbitrary source/config files through the asset handler. All allowed resources still receive ownership, path, size, and regular-file checks.

Validate and decode each requested path once. Reject absolute paths, malformed encodings, traversal, prohibited directory components, symlinks, and special files. Verify actual filesystem containment when opening files, including directory-symlink races; reuse the existing Linux descriptor-verification approach where appropriate and document platform limitations. Read from the verified descriptor rather than reopening a checked path.

Starting budgets: 2,000 discovered documents, 20,000 visited entries, maximum depth 32, 10 MiB per Markdown/HTML document, and 25 MiB per asset. Walk incrementally with bounded work and do not read all document bodies when listing. Report truncation when any discovery budget is reached. Enforce read caps even if files grow after inspection. Tune these constants only against representative report fixtures.

## Implementation sequence

### 1. Prove the report delivery model

- [ ] Add a small representative Gradle report fixture with multiple HTML pages, local CSS, images, and an interactive classic script, plus Markdown fixtures with local links/images.
- [ ] Exercise cookie authentication, opaque-origin sandboxing, HTTP sandbox headers, relative asset loading, report navigation, and full Refresh behavior in a real browser using the mocked E2E harness.
- [ ] Verify that report scripts cannot reach the shell DOM, app storage, or authenticated control APIs. Verify direct navigation remains sandboxed.
- [ ] Record the tested compatibility boundary in a new decision log using the next available number. If essential Gradle behavior fails, resolve the serving architecture before proceeding; do not fix it by combining same-origin privileges with report scripts.

This is the main technical uncertainty. The UI layout does not depend on its implementation details.

### 2. Add contracts and read-only delivery

- [ ] Add path, document-kind, document-entry, and list-response schemas to `packages/contracts/src/index.ts`, with contract tests.
- [ ] Create `apps/control/src/app/preview.ts` for discovery and serving; use a separate rendering helper if that keeps responsibilities clearer.
- [ ] Add the Markdown dependency to `apps/control/package.json` with Bun and update `bun.lock`.
- [ ] Wire the routes behind existing ownership checks in `workspace-routes.ts`. Add bounded metric templates in `metrics.ts`.
- [ ] Cover nested/generated files, duplicate filenames, case-insensitive extensions, exclusions, budgets, disappearing files, read limits, URL encoding, wrong users, unauthenticated requests, traversal, symlinks, special files, and unsupported MIME types in control-plane tests.

### 3. Add Preview UI

- [ ] Extend `SimPaneSwitcher.tsx` to accept `preview` in stored-value parsing, activation, selector, and panel composition. Keep AS as the default when no valid preference exists. Change the accessible group name from “Simulation pane” to “Right pane”.
- [ ] Add `PreviewPane.tsx` and `usePreviewDocuments.ts`. Reuse existing button and Base UI interaction conventions for the searchable picker; ensure keyboard search, selection, Escape, focus return, and a clear selected item.
- [ ] Load the file list on first activation, project invalidation, and explicit Refresh only. Keep Preview mounted after first use so its selection survives tab changes; do not add scroll tracking.
- [ ] Refresh starts a new list request and resets the iframe. Reopen the selected file if it remains listed; show a missing-file state otherwise. If list refresh fails, show an actionable error without presenting the old list as fresh.
- [ ] Model loading, ready, empty, missing-file, oversized-file, and request-error states. Render escaped error responses inside the iframe for document failures; an iframe load event alone must not imply an HTTP success.
- [ ] Prevent outdated requests from a prior selection or project from winning. Use an abort controller or request generation, and remount/reset on `reloadNonce`.
- [ ] Integrate Preview in `WorkspacePage.tsx`. Leave the topbar selector's position and existing pane dimensions unchanged.
- [ ] If the plain-Java extension is in scope, split layout visibility flags, add the topbar Preview show/hide action, and keep simulator hooks disabled.

### 4. Validate the complete workflow

- [ ] Extend `SimPaneSwitcher.test.tsx` for the third state, session preference, keyboard navigation, and preservation of existing AS/PP instances.
- [ ] Add frontend tests for searching full paths, README selection, no-README behavior, explicit Refresh of both resources, missing files, fetch errors, stale-response cancellation, and project-swap reset.
- [ ] Add mocked E2E flows that open Markdown with all external requests blocked; open a generated report, navigate its pages, and exercise its script; change/add/delete files on disk and click Refresh; switch to AS/PP and back; and replace the project while Preview is active.
- [ ] In E2E, assert refreshed CSS/script/image contents as well as refreshed HTML and file-list contents. Verify a previously scrolled document starts at the top after Refresh. Do not test scroll preservation.
- [ ] Add security E2E coverage for shell isolation, direct report URL isolation, cross-workspace access, and blocked API calls. Reuse existing auth and filesystem fixtures.
- [ ] Check desktop topbar fit at 901px, 1024px, and the supplied screenshot's general layout, long filenames, a narrow resized right pane, and keyboard-only interaction. Retain the current below-901px layout boundary.

### 5. Document and finish

- [ ] Add a student-facing Preview page under `docs/lessons/` describing selection, Refresh, report entry-page behavior, generated output discovery, and supported document/resource types. Update `docs/reference/faq.md` with the school-network workaround and external-resource limitation.
- [ ] Update `docs/about/security-model.md`, `docs/about/architecture.md`, and `docs/development/testing.md` as relevant to the final implementation. Keep the decision log aligned with the actual serving policy.
- [ ] Run `bun run check:fix`, then `bun run verify`; build the docs with `bun run docs:build`. Run `graphify update .` after code changes and inspect the final diff.
- [ ] No real-image Java smoke is required unless implementation unexpectedly changes the workspace editor, JDK, extensions, or init logic.

## Acceptance criteria

1. Preview appears beside AdvantageScope and PathPlanner in the current topbar position with a Lucide document icon.
2. A student can read the project's README without a third-party renderer request and can select nested Markdown or generated HTML through search.
3. A representative Gradle report renders with its local assets, page navigation, and basic script interactivity.
4. One Refresh action rescans files and fully reloads the selected entry and its assets, starting at the top. Newly generated reports become selectable immediately afterward.
5. Switching views preserves AS/PP state and the selected Preview entry. Replacing the project clears old content and selection.
6. Missing/empty/error states are understandable, and large trees/files have explicit limits rather than unbounded control-plane work.
7. Project content cannot read another workspace, escape the project root, or execute with the CodeRunner shell's privileges.
8. No auto-refresh or scroll-restoration subsystem is introduced.
