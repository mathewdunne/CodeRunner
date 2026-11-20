# 050 — Repo-sourced lesson modules

Status: **Accepted** — 2026-11-13

## Context

A catalog module has always been a `subdir` inside the catalog repository. That
works for a team's own curriculum, but external premade courses publish each
lesson as its own git repository. The [FRCSoftware.org learning
course](https://frcsoftware.org/learning-course), for example, is a progression
of template repositories that students fork and clone. Copying every lesson into
a catalog repo would duplicate upstream work and lose its history.

The catalog manifest therefore needs a second module source: a git repository
whose root is the lesson. Two delivery modes are useful:

- **Gitless** (the existing lesson model): the student receives a clean copy of
  the starting project, and Reset is a fresh re-load.
- **Preserved git tree**: the student also receives `.git` (the shallow clone,
  branch, and `origin`), so they can inspect history and commit to their own
  fork. This is the mode FRCSoftware's "fork and clone" workflow assumes.

## Decision

A module entry in `modules.json` defines **exactly one** of:

- `subdir` — a folder inside the catalog repo (existing behaviour), or
- `repo` — a public GitHub repository whose root is the lesson.

`repo` accepts `owner/repo` shorthand or `https://github.com/owner/repo(.git)`.
The manifest is admin-controlled, but the value is still normalized through the
same GitHub-only URL parser used by team imports, and `git clone` runs with an
argument vector (no shell interpolation).

`preserveGit` is a boolean, valid only with `repo`, defaulting to `false`:

| `repo` | `preserveGit` | Result |
| --- | --- | --- |
| absent | absent | Catalog `subdir` module; sparse clone (remote catalog) or `cp` (bundled). Always gitless. |
| present | `false` | Shallow clone of the module repo; `.git` removed after the workspace swap. |
| present | `true` | Shallow clone of the module repo; `.git` kept. |

A module `repo` is cloned with `git clone --depth 1` of its default branch. It
has no per-module branch field; a lesson that needs a different revision should
publish it on its default branch. There is no module `subdir` inside `repo`: the
repository root is the project root.

Repo modules use the existing catalog-load pipeline (size cap, empty-project
validation, workspace swap, editor cache clear, `current_module` recording) and
are not rate-limited, matching other lesson switches. `repo` works with both
catalog sources; the bundled manifest is baked into the image, so adding a repo
module to it requires an image rebuild, while a remote catalog picks it up
within the existing 60 s manifest cache.

## Consequences

- A catalog can mix first-party `subdir` modules and external `repo` lessons.
- Lesson work remains disposable by default. `preserveGit: true` is opt-in and
  makes the lesson behave like a team import for Git purposes (including the
  ability to commit, and to push only to a repository the student can write to).
- Cloning an external repo puts the control plane on the network even when the
  bundled catalog is active. Only admin-authored manifests can add such modules.
- The contract rejects a module with both or neither source, and rejects
  `preserveGit` on a `subdir` module, so invalid manifests surface as a catalog
  error instead of failing mid-load.
