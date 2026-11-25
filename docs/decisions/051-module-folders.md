# 051 — Nested module folders in the project picker

Status: **Accepted** — 2026-11-13

## Context

A catalog is an `order`-sorted list of modules. That is enough for the two
bundled demo lessons, but a real curriculum can mix first-party lessons with
external courses. The [FRCSoftware.org learning
course](https://frcsoftware.org/learning-course), for example, contributes many
repo-sourced stages alongside a team's own modules. A flat picker makes that
list hard to scan and hides which lessons belong to the same course.

Flat metadata such as a per-module `folder: "Stage 1"` label supports only one
level and separates the folder from the thing it groups. Curricula are naturally
trees, so the manifest should express that structure directly.

## Decision

The catalog `modules` array is a tree. Each entry is either a **module** (the
existing `id`/`title`/`description`/`subdir`|`repo`/`kind`/`order` object) or a
**folder**:

```json
{
  "schemaVersion": 1,
  "modules": [
    {
      "folder": "FRCSoftware Course",
      "description": "A premade Java and robotics curriculum.",
      "order": 20,
      "modules": [
        { "id": "course-stage-1", "title": "Stage 1", "order": 20, "...": "..." },
        {
          "folder": "Advanced",
          "order": 30,
          "modules": [
            {
              "id": "course-stage-2",
              "title": "Stage 2",
              "order": 30,
              "...": "..."
            }
          ]
        }
      ]
    }
  ]
}
```

A folder entry has three required fields and one optional field:

- `folder` — the displayed name. Trimmed, 1–80 characters, no `/`, `\`, or
  control characters. It is a label, not a path and not a filesystem location.
- `description` — optional one-line summary rendered under the folder name in
  the picker. It stays visible when the folder is collapsed.
- `order` — the display position among its siblings. Modules and folders share
  this one ordering scale.
- `modules` — an array of module and nested folder entries. Nesting is
  unlimited.

Folder names must be unique among siblings; the same name may appear under
different parents. This keeps the full path (for example
`Course/Advanced`) unique for UI state and React keys.

The tree is returned to the picker as-is by `GET /u/:slug/api/lessons`.
Internally the control plane flattens it depth-first to resolve a module by id,
so module IDs remain a global namespace and loading is unchanged.

### Ordering

`order` controls display position at every level of the tree:

- Modules and folders are sorted together by `order`, ascending. A folder's
  position is set by its own `order`, not by where it sits in the JSON array or
  by the `order` of the modules inside it.
- The `modules` array still defines hierarchy and breaks ties: entries with the
  same `order` keep their array sequence because the sort is stable.
- Modules are numbered only in a sibling list that contains no folders: a flat
  catalog counts 1, 2, 3 as before folders existed, and a folder holding only
  modules counts its own from 1. A list that mixes modules and folders is
  unnumbered, because one count would jump around the folders between its
  modules. Empty folders are hidden and do not count.

The picker renders consecutive modules as a grid, then a folder section, then
the next run, so a sibling list such as `[module, folder, module]` renders in
that sequence. Each nested folder level is indented under its parent. A folder
header shows the recursive module count and marks itself when the current module
is in its subtree. An optional folder description renders as a muted second line
under the name and remains visible while collapsed. Collapse state is keyed by
the full folder path and survives collapsing another folder, but resets when the
dialog closes.

### Validation

- The old flat per-module `folder` string is rejected rather than silently
  ignored; module entries are strict objects.
- A folder entry requires `folder`, `order`, and `modules`.
- Duplicate folder names among siblings fail the manifest parse, which surfaces
  as the catalog error state instead of producing colliding UI keys.
- Empty folders are accepted by the schema but produce no visible section.

## Consequences

- Catalogs can model multi-level curricula without splitting the catalog into
  multiple sources or changing module identity.
- Existing flat manifests remain valid: the top-level array is still a list of
  modules, and `order` still sorts them.
- Folder hierarchy lives in one obvious place in `modules.json` rather than in
  repeated module metadata.
- A remote catalog can change the tree without an app rebuild, subject to the
  existing 60 s manifest cache.
- The API response now contains folder entries. Clients that expect a flat
  module list must flatten it with `flattenLessonModules` or walk the tree.
- `order` is a sibling sort key, not a global sort. Authors control where a
  folder appears by changing its `order`, the same way they order modules.
