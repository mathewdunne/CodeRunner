# Decision 026: Editor Default Theme

## Status

Accepted.

## Context

CodeRunner should open fresh student workspaces in VS Code's `Default Dark Modern` theme. An earlier implementation wrote `Dark Modern` into `/config/data/Machine/settings.json`; that is the display label, not the theme id, and OpenVSCode 1.109.5 falls back to the default light theme.

## Decision

Seed the OpenVSCode Remote/Machine settings file at `/config/data/Machine/settings.json` during `init-frc-setup`:

```json
{
  "workbench.colorTheme": "Default Dark Modern"
}
```

The init script only fills this key when it is absent. It does not replace an existing Machine theme value.

## Consequences

- Fresh workspaces default to dark through the settings scope OpenVSCode actually applies before the first workbench render.
- Students can still choose another theme through User or Workspace settings, which override Machine settings through normal VS Code configuration precedence.
- No compatibility migration is needed for old workspace homes; the old workspace data has been removed.
