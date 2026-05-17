# Plan 06 — Project importer

## Context

Today, every student starts from a copy of [templates/wpilib-java-command/](../../templates/wpilib-java-command/) seeded
into `data/users/<workspaceId>/project/` on first login. There's no way to
load an existing GitHub repo (last year's robot code, a vendor template, a
teammate's project).

Add a "Import from GitHub" affordance: student pastes a URL, the control
plane clones the repo into their workspace, archives the previous project
state as a backup, and the student's editor refreshes onto the new code.

## Out of scope

- **Private-repo authentication.** GitHub-public-only for v1. Adding private
  support means broadening OAuth scopes and storing tokens — bigger plan.
- **Push-back-to-GitHub.** Students pull only. To share work back, they
  download (separate plan if it's needed).
- **Multi-project workspaces.** One project per workspace remains the V2
  model — importing replaces the current project.
- **Generic git providers.** GitHub URLs only for v1. GitLab/Bitbucket can
  follow if asked.

## Dependencies

- **[Plan 03](03-ui-scaffolding.md)** — uses shadcn `Dialog`, `Button`,
  `Progress`.
- **[Plan 05](05-auth-and-admin.md)** — needs real user identity (we want to
  attribute imports to a real OAuth identity, not a anonymous slug). Also
  the existing backup mechanism becomes more useful with auth in place.

## Tasks

### 1. UX — import dialog

- **Trigger:** a "Import from GitHub" item in a dropdown on the topbar
  (shadcn `DropdownMenu` next to the user avatar). Avoids cluttering the
  editor pane.
- **Dialog:** shadcn `Dialog`. Fields:
  - **GitHub URL** (required): accept repo URLs like
    `https://github.com/<owner>/<repo>` / `.git` and optionally parse GitHub
    tree URLs into branch/subdirectory fields.
  - **Branch** (optional, default `main`)
  - **Subdirectory** (optional, default empty — clones the whole repo into
    `project/`)
  - **Backup before import** (checkbox, default checked)
- **Confirm step:** on submit, show a confirm screen: "This will replace your
  current project with `<repo>`. Your current project will be backed up to
  `import-<timestamp>`. Continue?"
- **Progress:** during clone, show a `Progress` bar plus streaming log
  output in a `<ScrollArea>` (use the same WS message pattern as runs).

### 2. Backend endpoint

`POST /u/{slug}/project/import`

Body schema (validate with zod via `@frc-coderunner/contracts`):
```ts
{
  url: string,           // https://github.com/...
  branch?: string,       // default "main"
  subdir?: string,       // default ""
  backup?: boolean       // default true
}
```

Authorization: `requireWorkspaceOwnership` from [Plan 05](05-auth-and-admin.md)
§A.7.2. The WS stream endpoint `/u/{slug}/project/import-stream` (task 5)
calls the same helper before the upgrade and validates the Origin header
per §A.7.3. No re-auth challenge for v1; rely on the active session.

### 3. Validation

Reject before doing any work:

- URL must be a GitHub HTTPS URL. No SSH URLs, no other hosts.
- Normalize URL input before clone:
  - `https://github.com/<owner>/<repo>` and `.git` become clone URL
    `https://github.com/<owner>/<repo>.git`.
  - `https://github.com/<owner>/<repo>/tree/<branch>/<path>` is allowed only if
    it can be parsed into `{ cloneUrl, branch, subdir }`. If parsing is
    ambiguous, reject with a clear message and ask the student to fill branch
    and subdirectory manually.
  - Other GitHub path suffixes are rejected before any clone attempt.
- Branch name: standard git ref characters only, no leading `-`.
- Subdir: relative path, no `..`, no leading `/`.

After clone, before swapping in:

- Cloned tree must contain a `build.gradle` (in the subdir if specified,
  otherwise at the root). If not, fail with "Not a Gradle/WPILib project"
  and leave existing project untouched.
- Cloned tree size must be ≤ **100 MB**. If larger, fail with "Repository
  too large for import" and clean up.

### 4. Clone strategy

First verify that the V2 code image has `git`. If it is not present, install it
explicitly in [containers/code/Dockerfile](../../containers/code/Dockerfile)
rather than relying on the base image.

Run the clone **inside the student's running container** so we share its
filesystem layout and don't need a host-side git dependency:

1. Ensure the code container is running (use existing `ensureCodeContainer`).
2. Stage area: `/workspace/.import-<timestamp>/` inside the container.
3. Run `docker exec <container> git clone --depth 1 --branch <branch> --
   <url> /workspace/.import-<timestamp>/source` with a 60-second timeout.
4. If `subdir` was specified, the actual project root is
   `/workspace/.import-<timestamp>/source/<subdir>`.
5. Validate `build.gradle` exists at that root (task 3).
6. Measure size (`du -sb`); if over the cap, abort.
7. **Backup** the current `/workspace/project` to
   `data/users/<workspaceId>/backups/import-<timestamp>.tar` (host-side, via
   the existing backup helper used by the admin endpoint).
8. **Strip `.git/`** from the cloned tree before swap. We don't support
   push-back-to-GitHub and students have no creds; keeping the git history
   would let students stage a `git push` that always fails and would balloon
   workspace disk usage on large repos. Imports are explicitly one-way
   snapshots — document this in the dialog ("This imports a snapshot, not
   the git history").
9. **Swap contents, not the mount point.** `/workspace/project` is a bind mount,
   so do not `rm -rf /workspace/project && mv ... /workspace/project`. Instead:
   - Remove the existing contents inside `/workspace/project`, including dotfiles
     but not the `/workspace/project` directory itself.
   - Copy or move the imported project root's contents into the existing
     `/workspace/project` mount point.
   - Clean up `/workspace/.import-<timestamp>`.
10. **Refresh editor:** the openvscode-server picks up FS changes
    automatically (its watcher fires). Open tabs that point at deleted files
    behave the same way they do when you switch git branches in stock
    VS Code — the tab stays open, the file is marked deleted. That's
    acceptable; no special handling.

On failure at any step: leave `/workspace/project` untouched, clean up the
staging dir, return a clear error to the client.

### 5. Streaming feedback

Reuse the run channel pattern. Either:

- **Option A (simpler):** open a transient WebSocket at
  `/u/{slug}/project/import-stream` that streams clone log lines + a final
  status. Client opens this WS *before* sending the POST so the import
  response and the stream are decoupled. Or include a `streamId` in the POST
  response and have the client subscribe by ID.
- **Option B:** make the POST itself a streaming response (Bun supports
  ReadableStream responses) and parse the body as ND-JSON on the client.

Pick **Option A**. It mirrors the existing run channel and is easier to test.

### 6. Backup / restore wiring

- The pre-import backup uses the existing per-workspace backup helper
  (already exposed via `POST /admin/workspaces/:id/backup`). Refactor that
  helper into a function that the import endpoint and the admin endpoint
  both call.
- Backups land at `data/users/<workspaceId>/backups/import-<timestamp>.tar`
  with a sibling metadata `*.json` describing the import (URL, branch,
  imported_at).
- Surface in the import dialog: if the workspace has any
  `backups/import-*.tar` files, show a "Recent imports" list with a
  "Restore" button per entry.

### 7. Limits and quotas

- Per-workspace cap: keep ≤ 5 import backups; oldest gets pruned on each new
  import.
- Per-user rate limit: max 6 imports per hour (prevents accidental
  spamming).

### 8. Tests

Add `apps/control/src/__tests__/imports.test.ts`:

- URL validation: SSH URL → reject; non-github host → reject; valid public
  URL → accept (mock the `git clone` so the test doesn't hit the network).
- URL normalization: GitHub tree URL parses into clone URL + branch + subdir;
  unsupported GitHub suffixes reject before clone.
- Size cap: mock `du -sb` to return >100 MB → reject.
- Build.gradle check: mock the clone to produce no `build.gradle` → reject.
- Happy path: mock clone produces a valid tree → existing project backed up,
  swapped in, response shows success.
- Failure rollback: mock the swap step to fail → original project untouched,
  staging dir cleaned up.
- Auth: unauthenticated → 401; cross-workspace → 403.
- Rate limit: 7 imports in an hour → 7th rejected with 429.

Web: component test for the import dialog's URL validation, and an
integration test against a mocked `/u/{slug}/project/import` endpoint.

### 9. Decision log

Write `docs/decisions/016-project-import-strategy.md` capturing:

- Why clone-in-container instead of clone-on-host (filesystem alignment, no
  bind-mount, no host-side git dependency, blast radius is contained).
- Why we strip `.git/` after clone (no push-back support, no creds, disk
  cost on large repos, mental model is "snapshot import").
- Why public-only / GitHub-only for v1.
- The 100 MB size cap and 6/hour rate limit, with reasoning.
- One-way nature of imports — Restore comes from the pre-import backup, not
  from re-pulling the source repo.

### 10. Docs

Update `docs/runbook.md`:

- New endpoint reference.
- Import limits and where backups live.
- How to manually restore an import backup if the UI fails (admin route).

## Files modified / created / deleted

**Modified:**
- `apps/control/src/app.ts` (new endpoint + WS stream)
- `apps/control/src/containers.ts` (import helper that runs `git clone` in
  the container)
- `apps/control/src/storage.ts` (backup metadata, recent-imports query)
- `packages/contracts/src/index.ts` (import request/response/stream
  schemas)
- `apps/web/src/components/Topbar.tsx` (dropdown trigger)
- `docs/runbook.md`

**Created:**
- `apps/control/src/imports.ts` (clone orchestration helper)
- `apps/control/src/__tests__/imports.test.ts`
- `docs/decisions/016-project-import-strategy.md`
- `apps/web/src/components/ImportDialog/ImportDialog.tsx`
- `apps/web/src/components/ImportDialog/ImportProgress.tsx`
- `apps/web/src/components/ImportDialog/RecentImports.tsx`
- `apps/web/src/hooks/useImport.ts`

**Deleted:** none.

## Verification

1. **Happy path:** import a known-good public WPILib repo. Try
   [`wpilibsuite/allwpilib` example](https://github.com/wpilibsuite/allwpilib)
   with a subdir like `wpilibjExamples/src/main/java/edu/wpi/first/wpilibj/examples/getting-started`,
   or one of the smaller mirrored examples. Editor shows the new files. Click
   Run; the new code builds and the sim runs.
2. **Subdir clone:** import a monorepo and pull just one folder. Confirm the
   `project/` directory contains the contents of that folder, not the whole
   repo.
3. **Non-WPILib repo:** import a repo with no `build.gradle` (e.g., a python
   project). Clear error, project unchanged.
4. **Oversized repo:** import a repo known to exceed 100 MB
   (`torvalds/linux` is reliably way over). Rejected with a size error.
5. **Backup + restore round-trip:** import repo A, then click Restore on the
   pre-import backup. Original project returns. Test the editor still
   compiles and runs the original code.
6. **Concurrency:** trigger an import while another import is in progress in
   the same workspace. Second one queues or rejects (define behavior — likely
   reject with "import already in progress").
7. **Rate limit:** trigger 7 imports in a row. 7th rejected with 429.
8. **Tests:** `bun run test` — all green, including the new imports suite.
9. **MCP browser checks:** screenshot the import dialog and progress modal,
   confirm the design works. Watch console logs during import for warnings.
