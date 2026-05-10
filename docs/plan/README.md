# Post-V2 Plan

V2 is complete. This directory plans the next phase of work — cleanup chores
followed by feature work.

The architectural source of truth remains [V2-Design.md](../V2-Design.md). These
docs describe **what to do next** and assume V2's design is settled.

## The plans

| Plan | Title | One-line summary |
| --- | --- | --- |
| [01](01-cleanup-v1-mvp.md) | V1/MVP cleanup | Delete dead V1 orchestration code, archive `mvp/docs/`, drop the `mvp/` source tree. |
| [02](02-trim-tests-config.md) | Trim tests + config | Remove the build queue, split the 2,200-line test file, drop one-shot verification scripts. |
| [03](03-ui-scaffolding.md) | UI scaffolding | Add Tailwind + shadcn/ui, modularize `main.tsx`. **No behavior change.** |
| [04](04-driver-station.md) | Driver Station UI | SystemCore-style DS that actually toggles enable/disable + auto/teleop/test in the sim. |
| [05](05-auth-and-admin.md) | Auth + admin view | betterauth, email allowlist, GitHub + Google OAuth, admin UI over existing `/admin/*`. |
| [06](06-project-importer.md) | Project importer | Student pastes a GitHub URL, control plane clones into their workspace. |
| [07](07-hardening.md) | Operational hardening | Container concurrency cap, audit log for admin actions, CI workflow. |

## Dependency graph

```
01 ──┐
     ├──► 03 ──► 04 ──► 05 ──► 06
02 ──┘                  │
                        └────► 07
```

- **01** and **02** can run in parallel; 01 lands cleaner first because 02's
  test removals reference V1 cleanup tests that 01 deletes.
- **03** is independent of 01/02 but must land before 04/05 so they aren't
  retrofitted on top of pre-shadcn UI.
- **04** depends on 03 (uses shadcn primitives).
- **05** depends on 03 (admin UI uses shadcn) and bundles auth + admin together
  because admin's value depends on the role model auth introduces.
- **06** depends on 05 because it needs real user identity to attribute imports
  and gate the feature properly.
- **07** depends on 05 because the audit log records admin actions and the
  concurrency cap interacts with the user/role model. The CI portion is
  independent and can land earlier if convenient.

## Conventions for each plan doc

Every doc in this folder follows the same template:

1. **Context** — why this work, what problem it solves.
2. **Out of scope** — what this plan does NOT do.
3. **Tasks** — numbered, each with file paths and acceptance criteria.
4. **Files to modify / create / delete** — concrete list.
5. **Verification** — how to test end-to-end (commands, MCP preview steps,
   tests to add or run).
6. **Dependencies** — which other plan docs must land first.

Plan docs are meant to be picked up cold by an independent agent. If a doc
feels thin during execution, flesh it out as you go — but flag back if scope
needs to grow.

## Decisions baked in from the planning conversation

These four answers shaped every doc below; treat them as settled unless a plan
doc explicitly revisits them.

| Decision | Choice |
| --- | --- |
| Build queue (`RUN_CONCURRENCY`) | **Remove entirely.** Per-container memory caps + small classroom size make the queue's risk-mitigation value not worth the maintenance cost. |
| Driver Station scope | **Full functional.** Enable/Disable/Auto/Teleop/Test must actually toggle robot state in the sim. HALSim WebSocket extension is the WPILib-blessed path. |
| Feature ordering | **DS → Auth+Admin (bundled) → Importer.** |
| Cleanup style | **Archive `mvp/docs/` → `docs/archive/mvp-docs/`. Delete `mvp/` source outright. Archive obsolete decisions to `docs/decisions/archive/`.** |

## Out of scope for this whole batch

These are explicitly _not_ planned here. If they become priorities, plan them
separately in a `07+` doc:

- TLS / public-internet deployment.
- Multi-project workspaces (one project per workspace remains the V2 model).
- SAML / Okta / enterprise SSO.
- Push-back-to-GitHub from the importer.
- Controller / gamepad input binding (the DS plan leaves a placeholder).
- Real-time telemetry beyond what AdvantageScope already provides.
