# CodeRunner — Repo Notes for Codex

## What This Is

A browser-based IDE for learning FRC robot programming. Students write Java, click Run, and watch their robot simulate in real time with telemetry rendered by AdvantageScope Lite. Each student gets a per-student VSCodium container with bundled redhat.java and wpilibsuite.vscode-wpilib extensions for full VS Code editor features.

Architecture and design details: [`docs/about/architecture.md`](./docs/about/architecture.md). Decision logs live in [`docs/decisions/`](./docs/decisions/).

## Stack Rule

All non-container code is **TypeScript on Bun**. Use Bun for package management, TypeScript script execution, and the control-plane runtime. Keep `tsc --noEmit`/project references for typechecking.

Inside the V2 code container, Java/Gradle/WPILib, VSCodium, `redhat.java`, and `wpilibsuite.vscode-wpilib` are the relevant stacks.

## Repo Layout

```text
apps/control/                  Bun control plane: HTTP, WS, sessions, orchestration
apps/control/src/app.ts          slim factory + top-level fetch dispatcher
apps/control/src/app/            response/asset/proxy/status helpers + admin, workspace, websocket route groups
apps/control/src/app/preview*.ts discovery/serving, Markdown rendering, and the signed path token for Preview
apps/control/src/containers.ts   barrel re-exporting the public container surface
apps/control/src/containers/     Docker client, metadata, ports, lifecycle, and the LocalDockerRuntimeProvider class
apps/control/src/metrics.ts      Prometheus registry, metric handles, route-templating helpers
apps/control/src/metrics-collector.ts  15s Docker stats poller that writes per-container gauges
apps/web/                      React + Vite browser IDE shell
packages/contracts/            Shared API schemas, message types, and path rules
containers/code/               V2 merged VSCodium + sim container
containers/control/            Control-plane image: multi-stage build burying the emsdk/AdvantageScope compile, the coderunner dispatching entrypoint
catalog/                       Bundled (zero-config) lesson catalog: modules.json + modules/<id>/, baked into the code image
lessons-repo-root/             Staging for the standalone remote lessons repo (will move out of this repo); not used by the app build
scripts/                       TypeScript utility scripts run by Bun
patches/advantagescope/        Source-level AS Lite patches
docs/                          Site content (Docusaurus pages) + decision logs (docs/decisions/)
website/                       Docusaurus site config; docs/ is the content source
dashboards/                    Pre-built Grafana ops dashboard JSON (import into Grafana Cloud)
vendor/AdvantageScope/         Pinned upstream submodule
e2e/                           Playwright E2E tests (specs/ and fixtures/)
data/                          Runtime data, gitignored
```

## Current Status

- [x] V1-0 through V1-10: V1 complete (archived)
- [x] V2-0: editor spike accepted and recorded in `docs/decisions/011-v2-editor-spike.md`
- [x] V2-1: merged code container image
- [x] V2-2: authenticated editor proxy
- [x] V2-3: orchestrator merge and run-path migration
- [x] V2-4: web shell swap to hosted editor
- [x] V2-5: file API and contracts cleanup
- [x] V2-6: lifecycle, labels, and reconciliation
- [x] V2-7: acceptance pass

V2 is complete. The system uses per-student merged containers (`coderunner-workspace`) running VSCodium with bundled Java and WPILib extensions. The control plane proxies editor, run, and telemetry traffic through authenticated routes.

**Lessons & Modules (post-V2):** first-login template seeding is removed —
workspaces start empty and the student fills them via the topbar **Switch
Project** surface, which offers a lesson catalog plus a public GitHub team
import. The catalog has two sources behind one interface: a **bundled** `catalog/`
(zero-config, baked into the image) and a **remote** lessons repo when
`LESSONS_CATALOG_REPO` is set. Catalog loads are gitless (reset = re-load); team
imports keep `.git` for push. The per-import backup/restore flow was removed
(pure discard + git). See [`docs/lessons/overview.md`](./docs/lessons/overview.md)
and `docs/decisions/029-lessons-and-modules.md`.

**Project Preview (post-V2):** a third right-pane tab beside AdvantageScope
and PathPlanner reads the project's own Markdown and generated HTML reports
(`build/reports/**` included). Markdown is rendered in-process by
`markdown-it`; HTML reports are served unchanged with their local assets.
Project HTML is framed `sandbox="allow-scripts"` **without**
`allow-same-origin`, which costs the frame its `SameSite=Lax` session cookie —
so `/u/:slug/api/preview/files/` is authorised by a short-lived HMAC path
token instead, and is the one workspace route dispatched ahead of the cookie
ownership check (read-only, GET-only). `plain-java` lessons get a Preview
show/hide button in the selector's slot; `IDELayout` splits `showRightPane`
from `showDriverStation` to make that possible. See
`docs/decisions/041-project-preview.md` and
[`docs/using-coderunner.md`](./docs/using-coderunner.md).

**Classroom join codes (post-V2):** admins start a short-lived classroom
(Admin → Classrooms) with a 6-digit code; students join at `/join` with the
code and their name and become guest users (`user.classroomId` set, role
`student`, no allowlist). A custom Better Auth plugin
(`auth/classroom-plugin.ts`) mints the session; `app/classroom-routes.ts`
rate-limits failed attempts and retires the browser's previous guest
session. Guest sessions die with the classroom (checked in
`getSessionFromRequest`), guests have a **Leave** button that stops their
container, and `ClassroomSweeper` deletes guests of ended/expired
classrooms. See `docs/decisions/043-classroom-join-codes.md`.

**Containerized control plane (post-V2):** the control plane ships as a Docker
image (`containers/control/Dockerfile` → `ghcr.io/mathewdunne/coderunner-control`)
and is deployed with docker compose (`docker-compose.yml` base +
`docker-compose.prod.yml` for Caddy/Alloy; demo mode is `CODERUNNER_DEMO_MODE=1
docker compose up`, an env passthrough rather than an override file). It runs
the host Docker daemon over the bind-mounted socket and manages workspace
containers as siblings. The control container runs **non-root** as the data-dir
owner (image default `USER bun`; compose overrides via
`user: ${CODERUNNER_UID}:${CODERUNNER_GID}` with `group_add:
${CODERUNNER_DOCKER_GID}` for socket access), so `./data` stays host-owned, not
root-owned. Two modes via env: **port mode** (default;
`FRC_CONTAINER_NETWORK` unset) publishes loopback ports and is what
`bun run dev:control` uses; **network mode** (`FRC_CONTAINER_NETWORK=coderunner`)
joins a shared Docker network with no published ports and needs
`FRC_HOST_DATA_DIR` to translate bind-mount paths. Inside a container the
control plane self-inspects (`docker inspect` on itself) to auto-detect the
network, host data path, and workspace uid:gid, so those two env vars —
plus `FRC_CONTAINER_USER` — are optional overrides rather than required
plumbing; `CODERUNNER_ADMIN_EMAIL` bootstraps the first admin(s) with zero exec
steps; ops commands run as `coderunner <subcommand>` (a dispatching CLI baked
into the image) instead of `bun scripts/<name>.ts`. The image build runs the
emsdk/AdvantageScope compile in a build stage. See
`docs/decisions/031-containerized-control-plane.md`.

**CI, release, and multi-arch images (post-V2):** three workflows —
`ci.yml` runs `bun run verify` on PRs and pushes to main; `release.yml`
(on `v*` tag push) verifies, then publishes both images to GHCR as
multi-arch manifest lists (linux/amd64 + linux/arm64, built on native
runners and merged by digest) and uploads the web/ascope dist tarballs
to the GitHub release; `deploy.yml` (manual dispatch) preflights that a
tag is fully published, then rolls GCE/Cloudflare. The emsdk stage has
no arm64 image, so the arm64 control build reuses the amd64 job's
AdvantageScope dist via a named build context (the wasm output is
arch-independent). See `docs/decisions/035-multi-arch-images-and-workflow-split.md`.

## Working Principles

- Prefer boring, explicit TypeScript over clever abstractions.
- Use shared contracts before changing API shapes.
- Add or update a decision log for non-obvious architecture or tooling choices.
- Preserve student data under `data/users/<workspaceId>/project`, but note
  switching/resetting a lesson or importing a repo **intentionally discards** it
  (D4) — git is the safety net for team work, not server-side backups.
- Edit lessons in the remote lessons repo (or `catalog/` for the bundled demo);
  the bundled `catalog/` is the source of truth for the image's Gradle-cache
  priming and offline demos.
- Do not use query-param user identity in production routes.
- Do not expose per-user editor or NT4 ports directly to the browser.
- Keep AS Lite patches source-level and repeatable.
- Do not re-verify upstream extension-owned behavior unless editor or extension versions changed. Decisions 011 and 036 record the editor-specific evidence.
- Keep metrics instrumentation backend-agnostic. The control plane only speaks Prometheus exposition at `/metrics`; deploy-specific shipping (Alloy → Grafana Cloud, or whatever replaces it) lives outside `apps/control/`. Decision 023 is the record.
- Run `bun run check:fix` before finalizing any code change. It applies Biome's safe lint fixes, formatting, and import organization in one pass. `bun run verify` gates on `biome ci` so unfixed issues will fail CI.
- Documentation for users and operators lives in `docs/` (the Docusaurus site); update the relevant page when changing behavior. Decision logs stay in `docs/decisions/` and are not published to the site.

## Key References

- `docs/` + `website/` — docs site content and Docusaurus config; published at `https://mathewdunne.github.io/CodeRunner/`; run `bun run docs:dev` to browse locally, `bun run docs:build` to build.
- `docs/decisions/` — all architecture decision logs (011–043 active; 001–010 archived under `docs/decisions/archive/`).
- Pinned AdvantageScope submodule: `vendor/AdvantageScope` at tag `v26.0.2`.

## Commands

- Install dependencies: `bun install`
- Typecheck: `bun run typecheck`
- Lint + format + organize imports (write fixes): `bun run check:fix`
- Lint + format check only (no writes): `bun run check`
- Lint only: `bun run lint` (use `lint:fix` to apply safe fixes)
- Format only: `bun run format`
- Run Bun tests: `bun run test`
- Run frontend tests (Vitest): `bun run test:web`
- Run E2E tests (Playwright, mocked tier): `bun run e2e`
- Run E2E security tests: `bun run e2e:security`
- Build workspace image locally: `bun run docker:build:workspace`
- Build control image locally: `bun run docker:build:control`
- Pull workspace image from GHCR: `bun run docker:pull:workspace`
- Apply/check migrations: `bun run migrate`, `bun run migrate:status`
- Start control plane (dev, `--watch`): `bun run dev:control`
- Start web shell with HMR: `bun run dev:web`
- Start prod from source (migrates then serves): `bun run start`
- Run the containerized demo stack: `bun run demo:docker` (or `CODERUNNER_DEMO_MODE=1 docker compose up`)
- Containerized ops (compose deployments): `docker compose exec control coderunner <subcommand>` (or `docker compose run --rm control <subcommand>` while the plane is stopped) — see `docs/reference/cli-reference.md`
- Prod build (web + ascope + image pull): `bun run build`
- Backup projects: `bun run backup`
- Restore projects: `bun run restore -- <backup-dir>`
- Cleanup containers: `bun run docker:cleanup`
- Browse docs locally: `bun run docs:dev`
- Build docs site: `bun run docs:build`
- Install docs dependencies: `bun run docs:install`

See `docs/deploying/` and `docs/operating/` for operator documentation.

## Testing

Three test tiers, all runnable without Docker:

- **`bun run test`** — Bun unit/integration tests for the control plane (~450 tests). Covers auth, runs, proxy, containers, the lessons catalog + load pipeline, preview discovery/serving/tokens, security, reconciliation, property-based tests, and metrics route-templating cardinality.
- **`bun run test:web`** — Vitest frontend tests (~135 tests). Covers React hooks (`useSession`, `useLessons`, `useSimulationState`, `useContainerStatus`, `useAutoChoosers`, `useGamepad`, `useRunChannel`, `usePreviewDocuments`), DriverStation and PreviewPane components, Zustand store, keyboard/gamepad mappings.
- **`bun run e2e`** — Playwright E2E mocked tier (~75 tests). Full login→editor→run→telemetry→DS flows against in-process `ControlApp` with fake codium-server, HALSim, and NT4 backends, plus the Preview delivery/workflow/console-lesson specs. No Docker required.
- **`bun run e2e:security`** — Playwright security specs (~12 tests): CSRF, XSS output encoding, response headers, Preview isolation.

E2E tests use a custom Playwright fixture (`e2e/fixtures/app.ts`) that creates an isolated `ControlApp` per test with its own random port, SQLite DB, and fake upstream servers. Auth is seeded via `loginAs()` which writes user/session rows and HMAC-signs cookies.

Key E2E fixtures:
- `e2e/fixtures/fake-vscode.ts` — Fake codium-server (HTTP + WS upgrade)
- `e2e/fixtures/fake-halsim.ts` — Fake HALSim bridge (WS, supports stop/restart)
- `e2e/fixtures/fake-nt4.ts` — Fake NT4 server for topic announcement
- `e2e/fixtures/gamepad-shim.ts` — Playwright addInitScript gamepad override
- `e2e/fixtures/preview-project.ts` — Project tree with a Gradle-shaped HTML report
- `e2e/fixtures/runtime.ts` — Runtime seeding helpers

The broad Docker smoke tier remains intentionally unimplemented — see
`docs/decisions/022-skip-docker-smoke-and-import-tests.md`. A targeted real-image
Java workspace smoke is available as `bun run e2e:workspace-java` and is
required when the workspace JDK, editor base, Java/WPILib extensions, or init
logic changes (decision 038). The old per-import backup/restore flow is gone;
import coverage lives in control-plane tests plus the mocked E2E URL-validation
spec.

See [`docs/development/testing.md`](./docs/development/testing.md) for the full test architecture and catalog.

## graphify

This project has a graphify knowledge graph at `graphify-out/`.

Rules:
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure.
- If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code files in this session, run `graphify update .` to keep the graph current.
