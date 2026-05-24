# Fly.io Workspace Runtime — Third Deployment Mode

## Context

CodeRunner currently ships two deployment modes: all-in-one on a GCE VM (Caddy + Bun control plane + local Docker workspaces) and Cloudflare Pages frontend → the same GCE backend. The `WorkspaceRuntimeProvider` interface in [apps/control/src/runtime.ts](apps/control/src/runtime.ts) was introduced in decision 020 to make remote runtimes possible without a refactor; the only implementation today is `LocalDockerRuntimeProvider`.

We're adding a third mode that runs on Fly.io: a single Fly machine hosts the control plane, and it uses Fly's Machines REST API to create/start/stop **per-student workspace machines** that each run the existing `coderunner-workspace` openvscode-server image. The result is a cloud-native, scale-to-zero deployment alternative to the GCE host model. The existing two modes stay supported; provider selection becomes config-driven.

## Decisions (locked in)

| # | Decision |
|---|---|
| 1 | One Fly Volume per workspace machine (1:1 binding) for student project state |
| 2 | Pre-create one stopped Fly machine per workspace at sign-up time; start/stop on demand (subsecond cold start, avoids hot-path rate limits) |
| 3 | All workspace traffic (editor, NT4, HALSim, exec, files) goes through an HTTP/WebSocket "control sidecar" inside the workspace image, bound to `fly-local-6pn`, with **per-workspace bearer auth** (no global secret). It's the only 6PN-bound port on a workspace machine. |
| 4 | Both GCE modes stay; new env `FRC_RUNTIME_PROVIDER` selects `local-docker` (default) or `fly` |
| 5 | Control plane SQLite + file state on a Fly Volume attached to the control plane machine |
| 6 | Terraform Fly provider, mirroring `deploy/terraform/` layout |
| 7 | Fly volume snapshots + existing `bun run backup` script (no new scheduled job) |
| 8 | Keep Alloy → Grafana Cloud; run Alloy on the control plane machine |

## Fly API facts to design against

- `POST /v1/apps/{app}/machines/{id}/exec` is **synchronous only**, **capped at 30s**, and **rate-limited** → not used in steady state; the sidecar handles all exec.
- 6PN gives each machine `{machineId}.vm.{app}.internal` DNS; services bound to `fly-local-6pn` are reachable from any machine in the org's network — **this is not isolation by itself**.
- Rate limits: ~1 rps writes (burst 3), 5 rps reads → pre-creation keeps writes off the hot path; **a state cache (W4) keeps reads off the hot path**.
- Volumes are pinned to a physical host/region; persist after machine delete (need explicit cleanup).
- Auth: bearer token from `fly tokens deploy` (per-app scoped).
- `POST /v1/apps/{app}/machines/{id}` updates a Machine in place; `flyctl deploy` does **not** roll out to API-created machines (W12 covers this).

## Threat model & tenant isolation

Student code runs inside workspace machines and is untrusted. On Fly, every machine in the org can reach every other machine on 6PN by IPv6 — `.internal` DNS scopes by app name but doesn't prevent direct address routing. The current openvscode-server image runs with `--without-connection-token` ([containers/code/root/etc/s6-overlay/s6-rc.d/svc-openvscode-server/run](containers/code/root/etc/s6-overlay/s6-rc.d/svc-openvscode-server/run)) because Docker exposes it only on host loopback; HALSim and NT4 likewise have no auth. Re-exposing those on 6PN would let any student machine connect to any other student's editor and run arbitrary VS Code commands (full RCE in the victim workspace).

**Isolation strategy** (the "sidecar-only" rule by itself is not enforceable — student code can bind its own listener to the 6PN interface — so it's combined with an in-guest firewall):

1. **Sidecar is the only *first-party* 6PN-bound port on workspace machines.** Editor (port 3000), NT4 (5810), HALSim (3300) all bind to `127.0.0.1` inside the container. The sidecar listens on `fly-local-6pn:8787` and reverse-proxies authenticated requests to those loopback ports.
2. **In-guest nftables firewall (W13) enforces the sidecar-only invariant.** The workspace image init runs `nft` rules (under `CAP_NET_ADMIN`) that DROP all INPUT on the 6PN interface except `tcp dport 8787`, and DROP all OUTPUT on the 6PN interface except to the control plane machine's pinned 6PN address. Capabilities are dropped before student processes run, so student code cannot rewrite the rules. This is what makes "sidecar is the only reachable port" true even if a student opens their own listener.
3. **Per-workspace sidecar secret.** Generated at `provisionWorkspace` time, stored in `workspace_runtime_resources.sidecar_secret`, injected into the machine via per-machine env (not as a global Fly secret). Disclosure of one secret cannot compromise other workspaces.
4. **Sidecar auth never travels in a URL.** Bearer-in-`Authorization`-header for HTTP. For WebSocket upgrades, the control plane uses Bun's WS client with header injection (`new WebSocket(url, { headers })`); the proxy code never appends `?token=` (which would leak via the existing upstream URL logging in [apps/control/src/app/websocket.ts](apps/control/src/app/websocket.ts)). Sidecar enforces the bearer on the upgrade request and on every subsequent message channel.
5. **Cross-tenant tests** — `apps/control/src/fly/fly-runtime-provider.test.ts` and `containers/code/sidecar/sidecar.test.ts` cover: (a) workspace A's sidecar URL with workspace B's secret → 401; (b) a student-opened raw socket on the 6PN interface inside workspace A is unreachable from workspace B (validates the W13 firewall); (c) no `WorkspaceRuntime.endpoints` URL ever contains a `?token=` query or references ports 3000/5810/3300; (d) proxy log capture contains no bearer secret in any request URL.

DNS enumeration of machine IDs is not a vulnerability under this model since every port behind those addresses either drops at the firewall or requires the per-workspace bearer header.

## Workstreams

### W1 — Provider abstraction cleanup (prerequisite)

Today [app.ts:107](apps/control/src/app.ts:107) does `const containers = runtimeProvider as LocalDockerRuntimeProvider` and exposes `containers` on `ControlApp` and the route contexts ([app/types.ts:36](apps/control/src/app/types.ts:36)). It's used by `DockerStatsPoller` ([metrics-collector.ts:41](apps/control/src/metrics-collector.ts:41)) and by many tests under `apps/control/src/__tests__/` that reach in for Docker-only methods (`ensureCodeContainer`, `stopWorkspaceContainers`, `removeCodeContainer`, `cleanupStoppedContainers`, `managedContainerStats`).

Goal: confine those Docker-only surfaces so the Fly provider can satisfy the runtime contract without growing the interface.

- Keep the `containers` field, but make it **optional** on `ControlApp` and route contexts: present only when `runtimeProviderKind === "local-docker"`. Sites that already call interface methods (`runs.ts`, `idle.ts`, proxy code in `app/proxy.ts`) stay unchanged. Sites that need Docker-only surface (DockerStatsPoller, the existing tests) are gated on `containers != null`.
- `DockerStatsPoller` instantiation in [app.ts:142](apps/control/src/app.ts:142) becomes Docker-only. For Fly, add a parallel `FlyStatsPoller` (W4) that publishes the same metrics (active workspace count, plus whatever `listRuntimes()` can give us — Fly's API does not return CPU/mem percent, so per-workspace CPU/mem gauges degrade gracefully to `null`).
- No interface signature change. Don't add `provisionWorkspace` / `deprovisionWorkspace` to the interface yet — expose them via a small optional `WorkspaceLifecycleHooks` interface that only the Fly provider implements; call sites check `if ("provisionWorkspace" in runtimeProvider)`.

### W2 — Runtime provider selection / factory

- Extend [apps/control/src/config.ts](apps/control/src/config.ts) with `runtimeProviderKind: "local-docker" | "fly"` (env `FRC_RUNTIME_PROVIDER`, default `"local-docker"`) and a `fly` sub-config:
  - `FRC_FLY_API_TOKEN`
  - `FRC_FLY_APP_WORKSPACE` (workspace machines live in a separate Fly app)
  - `FRC_FLY_DEFAULT_REGION`
  - **`FRC_FLY_WORKSPACE_IMAGE_REFERENCE`** — digest-pinned reference like `ghcr.io/owner/coderunner-workspace@sha256:abc…`. Written to `config.image` on every machine create/update. W12 identity comparisons use this.
  - **`FRC_FLY_WORKSPACE_IMAGE_REVISION`** — human-readable label like `v2.4.1`. Operator-facing only; written to the `frc-image-revision` annotation metadata.
  - `FRC_FLY_MACHINE_CPUS`, `FRC_FLY_MACHINE_MEMORY_MB`, `FRC_FLY_VOLUME_SIZE_GB`.
  **No global sidecar secret env** — each workspace's secret is generated at `provisionWorkspace` time, stored in `workspace_runtime_resources.sidecar_secret`, and injected per-machine.
  Validation throws if mode is `fly` and any required field is missing, or if `FRC_FLY_WORKSPACE_IMAGE_REFERENCE` doesn't contain an `@sha256:` digest (rejects tag-only references at startup).
- New `apps/control/src/runtime-factory.ts` — `createRuntimeProvider(storage, options)` switches on the config. Only place that imports both providers. Replaces the inline construction at [app.ts:104-107](apps/control/src/app.ts:104).
- Update [app.ts](apps/control/src/app.ts) to call the factory; keep `containers` populated only when the returned provider is `LocalDockerRuntimeProvider`.

### W3 — Fly API client

New directory `apps/control/src/fly/`:

- `client.ts` — `FlyApiClient` wrapping `fetch` with bearer auth, base URL `https://api.machines.dev`. Methods accept an optional `leaseNonce?: string` parameter; when present, the client sends it as the `fly-machine-lease-nonce` HTTP header (per https://fly.io/docs/machines/api/machines-resource/#update-a-machine), **never as a JSON body field or query param**. Methods: `createMachine`, `updateMachine` (with `skip_launch: true` body field, leaseNonce header, W12), `startMachine` (leaseNonce header), `stopMachine` (leaseNonce header), `restartMachine`, `deleteMachine`, `getMachine`, `listMachines`, `waitForState`, `execSync`, `createVolume`, `deleteVolume`, `getVolume`, `listVolumes`, **`acquireMachineLease`** (`POST /v1/apps/{app}/machines/{id}/lease`; returns `{nonce, expires_at}` or 409 conflict on live-lease-held), **`refreshMachineLease`** (same endpoint with the existing nonce in the header to extend TTL), **`releaseMachineLease`** (`DELETE /v1/apps/{app}/machines/{id}/lease` with nonce header). Built-in token-bucket rate limiter (3-burst, 1 rps writes, 5 rps reads) that **queues** rather than rejects.
- Client tests reject any call that sends `lease_nonce` in a JSON body or query param (regression guard for the right contract).
- `types.ts` — hand-rolled TS types for the small surface we touch (no generated SDK).
- `errors.ts` — `FlyApiError`, `FlyRateLimitError`, `FlyNotFoundError`. Retry 429 + 5xx with capped exponential backoff; 404 surfaces immediately.
- `client.test.ts` — `fetch` mock, happy/rate-limit/404/retry paths, header & body shape assertions.

### W4 — `FlyMachinesRuntimeProvider`

New `apps/control/src/fly/fly-runtime-provider.ts` implementing `WorkspaceRuntimeProvider` plus the optional `WorkspaceLifecycleHooks`.

**Hot-path state cache.** Frontend hooks poll `/api/sim` every 1s, container status every 5s — those land in `ensureWorkspaceRunning` / `getWorkspaceStatus` ([apps/control/src/app/status.ts](apps/control/src/app/status.ts)). At 3 active students that already exceeds Fly's 5 rps read budget. The Fly provider holds an in-memory `Map<workspaceId, {runtime, fetchedAt}>` with a 15s TTL. Cache lookups return synchronously; cache misses or expired entries trigger one Fly call. Cache is invalidated on every `startMachine`/`stopMachine`/`restartMachine`/`removeMachine` returned by the provider, and on a 5xx response from `getMachine`. A `single-flight` map dedupes concurrent fetches for the same workspaceId.

- `provisionWorkspace(workspaceId)` — idempotent, single-flight (dedupes concurrent calls per workspaceId via an in-memory promise map). **Always searches Fly by `frc-workspace-id` metadata tag before any fresh create — never blindly creates a new machine/volume for a workspaceId that has live Fly resources.** Steps:
  1. Load `workspace_runtime_resources` row.
  2. If row present and both `fly_machine_id` + `fly_volume_id` resolve via `getMachine`/`getVolume` → no-op.
  3. If row present but referenced machine returns 404 → reattach: search `listMachines` for `frc-workspace-id=<workspaceId>` (non-quarantined). If found, update the DB row to point at it. If volume from the row is still alive, recreate the machine onto that volume (preserves student data). If neither, **fail closed** with `OrphanedVolumeError` (refuses to silently create a blank replacement that would shadow the DB pointer's missing volume).
  4. If no row → search by stable identity. Fly Machines support metadata tags (`frc-workspace-id=<workspaceId>`); **Fly Volumes have no metadata API**, and **Fly does not enforce volume name uniqueness per app** (it allows multiple with the same name + `require_unique_zone`). Volume identity is therefore a deterministic name used for *find*, not for uniqueness.
     - **Deterministic volume name:** `frc-ws-<sha256(workspaceId)[:23]>` (exactly 30 chars: 7-char prefix + 23 hex chars). Used regardless of workspaceId length — existing workspaceIds are `ws_<32hex>` (35 chars) so the direct-naming path never applies. The hash is stored in `fly_volume_name_index(workspace_id PK, fly_volume_name UNIQUE)` for fast lookup.
     - Search:
       - `listMachines` filtered by metadata `frc-workspace-id=<workspaceId>`.
       - `listVolumes` then filtered by the deterministic name match (Fly returns full lists; filter client-side).
     - Cases:
       - **One live machine + one live volume** that match (machine references the volume) → re-import: write `workspace_runtime_resources` from the machine metadata + volume id, recovering `sidecar_secret` from the machine's env via `getMachine`. Done.
       - **One live volume by name, no machine** → adopt the volume: create the machine attached to it. Same `sidecar_secret` is regenerated and re-injected.
       - **No volume, no machine** → fresh create (see step 5).
       - **Any quarantined match** — quarantine state lives in `quarantined_fly_resources(fly_id, kind, workspace_id_hint, …)` (W5). Before any create-on-empty path, the provider checks this table; presence of a row for this workspaceId → **fail closed** with `QuarantinedResourceError("workspace <id> has quarantined Fly resources; run `bun run fly:reconcile --import` before this workspace can be started")`.
       - **Multiple live volumes with the same deterministic name** (Fly allows this and so do crash-induced double-creates) → **fail closed** with `MultipleCandidatesError(<details>)`. The reconcile CLI surfaces these for operator resolution; auto-picking would risk losing data on the duplicate.
       - **Multiple live machines tagged with the same workspaceId** — same fail-closed response.
  5. **Idempotent create with adopt-before-create.** Even on the no-row, no-existing-resources path, never call `createVolume` blindly. Sequence:
     a. **Adopt-first.** Re-run `listVolumes` filtered by the deterministic name. If exactly one matches → adopt (it was created by a prior crashed attempt or external action). If multiple → fail closed.
     b. **Create.** `createVolume(name=deterministicName, size, region)`. Capture the response.
     c. **Verify-by-name.** Immediately re-run `listVolumes` filtered by the deterministic name. The expectation is exactly one matching volume whose ID equals the one we just created. If multiple matches → another caller raced us; fail closed with `MultipleCandidatesError`, do not retry create.
     d. Only after a single-match verification: write the workspace_runtime_resources row (with the volume id and name), then create the machine attached to it.
     A crash in the middle of (b)–(d) is recoverable on the next call: step (a)'s adopt-first finds the orphan volume by name and skips re-creating it.
     The machine create call passes `frc-workspace-id=<workspaceId>` metadata. A duplicate machine for the same workspaceId surfaces as `MultipleCandidatesError` in step 4 on the next call.
  Machine config:
  - Image from `config.fly.flyWorkspaceImageReference` (digest-pinned `<repo>@sha256:…`). After `createMachine` returns successfully, the same transaction that writes the runtime resources row also sets `provisioned_image_digest = <createdDigest>`, `provisioned_image_revision = config.fly.flyWorkspaceImageRevision`, and `provisioned_config_json = <normalized full config we POSTed>`. **`current_image_digest` stays NULL until the first `ensureWorkspaceRunning` runs full-config verification and commits** — preserves the invariant that `current_image_*` means "health-confirmed against the full expected config", not just "we asked Fly for this digest".
  - Volume mount at the workspace data path used by the image.
  - Env vars: `WORKSPACE_SIDECAR_SECRET=<row.sidecar_secret>`, `VSCODE_BASE_PATH=/u/<slug>/vscode/`, `FRC_WORKSPACE_ID=<workspaceId>`, `FRC_CONTROL_PLANE_6PN=<control-plane-machine-6pn-address>` (W13 uses this for the egress allow-rule), plus whatever the existing image's init scripts require (audit `containers/code/root/etc/s6-overlay/...` and `containers/code/start-sim.sh` before W4 lands).
  - Restart policy `no`. No Fly `services:` (no public exposure); the sidecar listens internally on 6PN.
  - Required `CAP_NET_ADMIN` so the in-guest init can install nftables rules (W13), dropped before student processes run.
  - Metadata: `frc-coderunner-workspace=true`, `frc-workspace-id=<workspaceId>`, `frc-image-revision=<…>`, `frc-creation-intent=<uuid>`. The `frc-workspace-id` tag is the immutable mapping fallback used everywhere (provisioning step 3/4, W12 rollout, W12 reconcile CLI) if `workspace_runtime_resources` is ever lost.
- `ensureWorkspaceRunning` — **self-healing**. Single-flight per workspaceId. Steps:
  1. Check cache → return if fresh and `state === "started"`.
  2. Load resource row, call `provisionWorkspace` if missing or referenced machine/volume returns 404.
  3. **Start gate** via the centralized `canStartMachine(workspaceId) → {ok, reason?}` helper. If not OK (`repair_required = TRUE` OR `rollout_in_progress = TRUE`), return `WorkspaceUnderMaintenanceError` (HTTP 503 with a user-friendly "your workspace is being repaired; ask the instructor" message). Never call `startMachine` for a workspace whose config might be unsafe.
  4. **First-start full-config verification** — only when `current_image_digest IS NULL` (machine has been provisioned but never health-confirmed). `getMachine` and run **full-equality verification** against the persisted `provisioned_config_json` (the W12 schema's `pending_target_config_json` analogue, set by `provisionWorkspace` at create time): mounts, env (full map equality), services, restart policy, guest sizing, init/processes/checks, capabilities, both metadata tags, and `image_ref.digest === provisioned_image_digest`. Digest equality alone is insufficient — a same-digest machine could have its mount or capabilities mutated externally before first start, passing a digest check while quietly being unsafe. If any field mismatches → set `repair_required = TRUE`, return `WorkspaceUnderMaintenanceError`.
  5. `startMachine` if state ≠ `started`; `waitForState("started", 15s)`.
  6. Sidecar `/healthz` probe. Failure → return error to the user without populating the success cache.
  7. **First-start commit** — only when `current_image_digest IS NULL` AND we just successfully started + health-checked. CAS-set `current_image_digest = provisioned_image_digest`, `current_image_revision = provisioned_image_revision`, clear `provisioned_config_json`. From this point on, the row participates in rollout selection normally.
  8. Populate cache, return `WorkspaceRuntime` with **sidecar-prefixed endpoints** (see below).
  
  Post-OAuth race where the user lands in the editor before background provision finishes is covered by step (2).
- `WorkspaceRuntime.endpoints` (Fly mode) — all routed through the sidecar's single 6PN port:
  - vscode: `http://{machineId}.vm.{flyApp}.internal:8787/vscode/`, ws `ws://…:8787/vscode/`
  - nt4: `http://…:8787/nt4/`, ws `ws://…:8787/nt4/AdvantageScopeLite`
  - halsim: ws `ws://…:8787/halsim/wpilibws`
  The control plane proxy is **server-to-server** — it uses Bun's WS client with header injection (`new WebSocket(url, { headers: { Authorization: "Bearer …" } })`), not browser-style query tokens. **No bearer ever appears in a URL.** The browser-to-control-plane WS is already authenticated by the existing session cookie. The proxy's existing URL logging in [apps/control/src/app/websocket.ts](apps/control/src/app/websocket.ts) is harmless under this scheme; W4 still adds a log-redaction sanity check (no `Bearer` or hex-looking 32+ char strings should appear in logged URLs) as a regression guard. **No editor/NT4/HALSim port ever appears in a returned URL** — covered by the cross-tenant test in the threat-model section.
- `stopWorkspace` / `restartWorkspace` — `stopWorkspace` always allowed (stop is safe). `restartWorkspace` routes through `canStartMachine()` first; refuses if `repair_required` or `rollout_in_progress`. Invalidate cache on success.
- `removeWorkspace` / `deprovisionWorkspace` — explicit operator/admin path. Delete machine, then volume, then DB row. Surface non-`NotFound` errors. Distinct from `cleanupStoppedRuntimes` (which never deletes — see next bullet).
- `getWorkspaceStatus` — read-through cache; map Fly state → existing `ContainerState`.
- `exec` — **routed through the sidecar**, not Fly's `POST /machines/{id}/exec` (which is 30s-capped and rate-limited). The existing `imports.ts` uses `exec` with a 60s timeout for `git clone` — the sidecar honors the caller's `timeoutMs`. Fly's native exec is reserved for emergency operator debugging.
- `execStream` — sidecar WS protocol per W7.
- `listRuntimes` — `listMachines` filtered by `frc-coderunner-workspace=true`, mapped to `ManagedWorkspaceRuntime` (cpu/mem fields null — Fly doesn't expose them).
- `cleanupStoppedRuntimes` — **never deletes**. Reconciliation logic:
  - Machine tagged `frc-coderunner-workspace=true` whose `frc-workspace-id` doesn't match any DB row → insert into `quarantined_fly_resources` (kind=machine, fly_id, workspace_id_hint from the tag, reason), additionally re-tag the machine itself with `frc-coderunner-quarantined=<ISO8601>` (machine metadata IS mutable, unlike volumes), stop the machine if running, log structured `runtime.orphan_detected`, emit a metric. Operator runs `bun run fly:reconcile` (W12) to import or hard-delete.
  - **Volume name-prefixed `frc-ws-` with no matching DB row and no machine referencing it** → insert into `quarantined_fly_resources` (kind=volume, fly_id=<volumeId>, workspace_id_hint=<reverse-lookup-or-NULL>, reason). The hash-based deterministic name is NOT reversible, so `workspace_id_hint` is best-effort: look up the volume name in `fly_volume_name_index` and use the matching `workspace_id` if found, else `NULL`. Volume cannot be re-tagged (Fly API limitation); the DB table IS the quarantine record. Log `runtime.orphan_volume_detected`, emit a metric. Volumes never auto-delete. `bun run fly:reconcile` lists these and offers `--import <flyVolumeId> --workspace <id>` (operator-supplied mapping required when `workspace_id_hint IS NULL`; recreates DB row + machine) or `--delete <flyVolumeId> --confirm <flyVolumeId>` (double-confirm). Adoption (in `provisionWorkspace` step 4) explicitly checks `quarantined_fly_resources` by `fly_id` for each candidate volume and refuses to adopt a quarantined one even if the deterministic name matches.
  - DB row pointing at a missing machine → log `runtime.missing_machine`, attempt to recreate via `provisionWorkspace` (volume may still exist; step 3 already handles).
  - DB row pointing at a missing volume → log `runtime.missing_volume` loudly and refuse to auto-act. This is the failure mode that loses student data; never attempt automatic recovery.
  - Quarantine table entries for resources that no longer exist in Fly (operator hard-deleted them outside the CLI) → delete the DB row to keep the table tidy.
- `countRunningWorkspaces` — read-through cache count of `state === "started"`.

New `apps/control/src/fly/fly-runtime-provider.test.ts` — `FakeFlyApiClient` with in-memory machines/volumes. Cases:
- Provision idempotency (all five cases in steps 1–4 above).
- **DB-rollback race:** simulate `workspace_runtime_resources` being absent while a Fly machine + volume tagged with the same `frc-workspace-id` exist. `provisionWorkspace` must re-import, never double-create.
- **Crash-after-volume-create race:** simulate a volume with the deterministic name exists with no matching machine and no DB row → `provisionWorkspace` adopts the volume by name and creates the machine attached to it (never creates a second volume).
- **Adopt-before-create on retry:** simulate a crash mid-create then re-invoke; the second call must call `listVolumes` first, find the orphan, adopt it, never issue a second `createVolume`.
- **Multiple-volumes-same-name fail-closed:** seed two Fly volumes both named the deterministic value. Provisioning's verify-by-name step (5c) sees multiple matches and throws `MultipleCandidatesError`; no fresh volume is created; no DB row is written. Operator runs `bun run fly:reconcile`.
- **Volume name length compliance:** assert the generated name for every existing workspace ID format (`ws_<32hex>`) is exactly 30 characters and matches Fly's name validation regex. Regression-guard against off-by-one.
- **Quarantined-resource block:** `provisionWorkspace` against a workspaceId with a row in `quarantined_fly_resources` (kind=machine or kind=volume) throws `QuarantinedResourceError`; no fresh resources are created. Verified explicitly because Fly volumes have no metadata API, so quarantine state lives only in the DB table.
- **Newly-provisioned machine no-op:** `provisionWorkspace` writes `current_image_digest = createdDigest` in the same transaction. The first rollout pass against this row sees `current_image_digest === targetDigest` AND `pending_target_config_json IS NULL` AND `rollout_in_progress = FALSE` → no-op, no `repair_required`. Without this, every freshly-created workspace would be falsely quarantined on first rollout.
- **Multiple-candidates fail-closed:** two volumes tagged with the same workspaceId → `MultipleCandidatesError` raised; nothing is created or deleted.
- **DB-write-failure race:** simulate Fly create succeeds but the DB write throws. The next `provisionWorkspace` call finds the resources by tag and re-imports — no orphaned Fly resources, no double-create.
- Self-healing `ensureWorkspaceRunning` when no DB row, when machine missing, when volume missing-but-row-present (must throw `OrphanedVolumeError`, not silently rebuild).
- **Start gate honored across all start paths:** `ensureWorkspaceRunning`, `restartWorkspace`, backup driver, and restore driver all reject `repair_required = TRUE` and `rollout_in_progress = TRUE` rows; **no `startMachine` call is issued**. All four route through the shared `canStartMachine()` helper. Restore's `--force-restore-into-repair <workspaceId>` flag is the only override and is workspace-scoped.
- **First-start full-config verification:** a freshly-provisioned workspace with matching `provisioned_image_digest` and `provisioned_config_json`. First `ensureWorkspaceRunning` runs full-equality verification (mounts, env, services, restart, guest, init, caps, metadata, digest), starts, health-checks, CAS-writes `current_image_digest = D` and clears `provisioned_config_json`.
- **First-start same-digest mount-dropped:** machine's `image_ref.digest` matches but mount was externally removed before first start. Verification catches the mismatch → `repair_required = TRUE`, never calls `startMachine`. Same assertions for changed env, unexpected service, missing capability.
- **First-start digest mismatch:** machine's actual digest differs from `provisioned_image_digest`. Verification fails → `repair_required = TRUE`, never calls `startMachine`.
- **Recovery containment shares the update-phase routine:** simulate a crash where Fly auto-launched a partially-applied config (state=started, observed digest matches `pending_target_config_json`'s digest but other fields don't). The next `rolloutWorkspace` call hits the recovery branch; verification fails; the provider issues `stopMachine` with the lease nonce, waits for stopped, THEN releases the lease and sets `repair_required`. Recovery and immediate-update verification failures share one containment routine — no recovery branch can leave a malformed machine running.
- **Restore refuses repair_required without exception:** workspace is `repair_required` (e.g. because update dropped the volume mount). `bun run restore` against this workspace logs `status: "skipped_repair_required"` in the manifest and **does not call `startMachine` or extract any data**. No `--force-restore-into-repair` flag exists; the documented recovery path is `--recreate` followed by normal restore.
- **Never-started + matching-target no-op:** `current_image_digest IS NULL` AND `provisioned_image_digest === targetDigest`. The CLI selector excludes this row; ordinary `rolloutWorkspace` against it returns early without acquiring any lock; the row only advances via the next `ensureWorkspaceRunning`.
- **Containment on auto-launched mismatch:** simulate the fake Fly auto-launching a partially-applied config (state=started after update). The provider issues `stopMachine` with the lease nonce, waits for stopped state, THEN sets `repair_required` and releases the Fly lease. The malformed machine is never left running.
- **Lease retention on containment failure:** if the stop call fails or state remains uncertain, the provider DOES NOT release the Fly lease. `containment_failure` is recorded; the reconcile CLI shows this row with elevated severity. Operator must manually inspect.
- State cache hit/miss/invalidate, single-flight dedup under 50 concurrent callers.
- Cross-tenant: request to A's sidecar URL with B's secret → 401; returned endpoints never reference editor/NT4/HALSim ports directly and never include `?token=`.
- **Log-redaction guard:** capture proxy logs through a Fly-mode request; assert no bearer or 32+-char hex string appears in logged URLs.
- **WS auth contract:** Fly provider opens upstream WS to the sidecar using header injection, never query token. Sidecar fake rejects any WS upgrade carrying `?token=` with 400 (defense-in-depth check).
- Reconciliation quarantines machines AND orphaned volumes — never deletes — including the "DB rolled back to older snapshot" simulation.
- Exec at 60s timeout succeeds (no 30s clamp).

### W5 — SQLite schema for Fly resources

- New migration `apps/control/migrations/011_workspace_runtime_resources.sql` — additive tables:
  ```
  workspace_runtime_resources(
    workspace_id PK,
    provider_kind TEXT NOT NULL,
    fly_machine_id TEXT,
    fly_volume_id TEXT,
    fly_volume_name TEXT,        -- deterministic name for orphan recovery (W4)
    fly_region TEXT,
    sidecar_secret TEXT,
    created_at TEXT, updated_at TEXT
    -- W12 columns added by migration 012; see W12's Schema block
  );

  quarantined_fly_resources(
    fly_id TEXT PK,
    kind TEXT NOT NULL,           -- "machine" | "volume"
    workspace_id_hint TEXT,       -- from machine tag or volume name; nullable for legacy orphans
    quarantined_at TEXT NOT NULL,
    reason TEXT NOT NULL
  );

  fly_volume_name_index(
    workspace_id TEXT PK,
    fly_volume_name TEXT NOT NULL UNIQUE
  );
  -- Stores the hashed deterministic name (`frc-ws-<sha256(workspaceId)[:23]>`, 30 chars total)
  -- because that hash is not reversible. Adoption looks up by workspace_id → name. Orphan
  -- reconciliation looks up by name → workspace_id (best-effort hint only).
  ```
  Keep `container_leases` untouched — port-oriented columns are meaningless for Fly, lifecycle is different (per-run port reallocation vs per-workspace-lifetime machine). Additive design also leaves room for a future provider.
- Add `getWorkspaceRuntimeResource`, `upsertWorkspaceRuntimeResource`, `deleteWorkspaceRuntimeResource` to [storage.ts](apps/control/src/storage.ts). Only the Fly provider calls them.
- Fix idle-sweep query: `storage.listIdleWorkspaceIds` today joins `container_leases.code_state` so Fly workspaces would never be swept. Replace with a provider-agnostic candidate query (`workspaces.last_accessed_at < cutoff` with rows present in **either** `container_leases` or `workspace_runtime_resources`), then have `IdleManager` filter to actually-running via `provider.getWorkspaceStatus()` before stopping.

### W6 — Workspace lifecycle wiring

- Find the workspace-creation site (in `auth/auth.ts`'s `ensureWorkspace` callback or `storage.ensureWorkspaceForUser`). After the row commits, if the provider implements `WorkspaceLifecycleHooks`, call `provisionWorkspace(workspaceId)` in the background with retry. Don't block login on Fly machine creation — if it fails, the next `ensureWorkspaceRunning` will retry it on demand.
- Find the workspace-deletion site (admin route or anywhere a workspace row is hard-deleted). Call `deprovisionWorkspace` before deleting the row.
- Add a periodic reconciliation tick (re-uses `cleanupStoppedRuntimes`) that's safe to run on Docker (no-op) and meaningful on Fly. Wire into the existing reconciliation hooks or run from `IdleManager`'s tick.

### W7 — Control sidecar in workspace image (single 6PN-bound surface)

The sidecar is the **only** port bound on `fly-local-6pn`. Editor, NT4, HALSim, and all file/exec operations flow through it. Per-workspace bearer auth on every request.

New `containers/code/sidecar/` — small Bun HTTP+WS service:

**Auth.** `Authorization: Bearer <WORKSPACE_SIDECAR_SECRET>` on **every** request, **including WebSocket upgrades** — there is no query-token fallback. The control plane (not a browser) is the only client and uses Bun's WS client with header injection (`new WebSocket(url, { headers: { Authorization: "Bearer …" } })`). Sidecar must explicitly reject any request whose URL contains `?token=` (defense-in-depth against accidental client regressions — return 400 with a fixed message, not 401, so the failure mode is loud). Compared with constant-time equality against the env-injected per-workspace secret. Reject missing/wrong bearer with 401. No global secret.

**Bind.** `[fly-local-6pn]:8787` in Fly mode. For local image testing, accept a `SIDECAR_BIND_HOST` env override.

**Endpoints:**

- `GET /healthz` → 200.
- **Reverse proxy** for browser-facing services. The control plane proxies `/u/{slug}/vscode/...` etc. to these paths; the sidecar in turn proxies to the loopback ports inside the same container:
  - `ANY /vscode/...` → `http://127.0.0.1:3000/...` (HTTP + WS upgrade). Preserves `VSCODE_BASE_PATH` rewriting.
  - `ANY /nt4/...` → `http://127.0.0.1:5810/...` (HTTP + WS).
  - `ANY /halsim/...` → `ws://127.0.0.1:3300/...` (WS only).
- **Exec.** `POST /exec` body `{cmd: string[], stdin?: string, timeoutMs?: number}` →
  - synchronous mode (returns when process exits or timeout): response `{stdout, stderr, exitCode, exitSignal}`. Used for `WorkspaceRuntimeProvider.exec`.
  - streaming mode (caller passes `?stream=1`): response `{streamId, wsPath}`. Client opens `WS /stream/{streamId}` and receives `{type:"stdout"|"stderr",data:base64}` frames, terminator `{type:"exit",code,signal}`. Accepts `{type:"kill",signal}` from client. Used for `execStream`.
- **File store** (consumed by the `WorkspaceFileStore` Fly impl in W11). All paths are scoped by a `ns` (namespace) query parameter that selects which workspace subdirectory the operation targets: `ns ∈ {project, assets, logs, backups}`. The sidecar resolves each `ns` against a hard-coded volume-rooted directory (`/workspace/project`, `/workspace/assets`, `/workspace/logs`, `/workspace/backups`) and rejects path traversal (`..`, absolute paths). Unknown `ns` → 400.
  - `GET /files/tree?ns=<ns>&path=...` → directory listing.
  - `GET /files/blob?ns=<ns>&path=...` → raw file bytes.
  - `PUT /files/blob?ns=<ns>&path=...` → write file bytes (body is content). Atomic via tempfile + rename.
  - `DELETE /files/blob?ns=<ns>&path=...`
  - `GET /files/du?ns=<ns>` → bytes used in the namespace (used by `diskUsage`).
  - `POST /files/archive?ns=<ns>&path=...` → returns a tar stream of a subtree.
  - `POST /files/extract?ns=<ns>&path=...&mode=replace|merge` → accepts a tar stream.
    - **All modes validate tar members before writing:** reject any member with `..`, absolute paths, symlinks targeting outside the target, or hardlinks targeting outside the target. Reject members larger than a configured per-file cap and totals larger than a per-archive cap (DoS guards).
    - `mode=replace` (default for restore): **never** pre-deletes the target. **Requires** `renameat2(RENAME_EXCHANGE)` (Linux ≥ 3.15, ext4/xfs/btrfs all support it). Fly volumes are ext4 + modern kernel, so this is satisfied; sidecar startup probes for the capability with a tiny self-test and fails closed if absent (the two-rename fallback is intentionally not implemented — it requires a complex multi-state recovery journal to be crash-safe, and the kernel primitive already exists).
      1. Extract into a sibling tempdir `<path>.incoming.<uuid>` under the same `ns`.
      2. Validate the extracted tree against the same per-member rules.
      3. Write a recovery-journal file `<ns>/.replace-journal.<uuid>` containing `{incoming: "<path>.incoming.<uuid>", canonical: "<path>", state: "pending"}`, `fsync` it, then `fsync` the parent dir.
      4. **Atomic swap** via `renameat2(canonical, incoming, RENAME_EXCHANGE)`. Single syscall, kernel-atomic. After this call, the canonical name points at the new tree and the incoming-named dir points at the old.
      5. Mark journal `{state: "swapped"}`, `fsync`. `rm -rf` the incoming-named dir (now containing old data). Unlink the journal.
      6. **Sidecar startup reconciliation.** Before serving any request, scan each `ns` for `.replace-journal.*` files. For each:
         - `state: "pending"` → swap never happened. The canonical path still has the original tree; the incoming dir has the (validated but not committed) new tree. Delete the incoming dir, unlink the journal.
         - `state: "swapped"` → swap succeeded but cleanup didn't. Canonical has new content; the incoming-named dir has the old. Delete it, unlink the journal.
         Idempotent — re-running converges.
      Any failure before step (4) → `rm -rf` the incoming tempdir, unlink the journal, original `<path>` untouched. At every observable moment the canonical path holds a valid tree (original before swap, new after swap).
    - `mode=merge`: extract over existing tree without pre-deletion (used by template seeding and overlay updates). Same validation rules apply.
  - `POST /files/seed-template` → idempotent: if `ns=project` is empty, copies `/workspace/template/` into it (`extract` with `mode=merge` against the bundled template tar). Returns `{seeded: boolean}`.

**s6 wiring.** Separate longrun `containers/code/root/etc/s6-overlay/s6-rc.d/svc-frc-sidecar/` parallel to `svc-openvscode-server`. Independent failure domain. Added to `user/contents.d/`.

**Dockerfile.** [containers/code/Dockerfile](containers/code/Dockerfile) installs the sidecar binary (Bun single-file build) at `/usr/local/bin/frc-sidecar`. No `EXPOSE` (Fly services declare ports).

**openvscode-server config change.** Keep `--without-connection-token` because the editor is now bound to 127.0.0.1 only and the sidecar enforces the per-workspace bearer. Add no public service. Audit `containers/code/root/etc/s6-overlay/s6-rc.d/svc-openvscode-server/run` and `containers/code/start-sim.sh` to confirm editor and HALSim bind to `127.0.0.1` (today they listen on `0.0.0.0`, which is harmless under Docker host-loopback publish but matters on Fly — change the listen address to `127.0.0.1` defensively).

**Tests.** `containers/code/sidecar/sidecar.test.ts`:
- Protocol (sync exec, streaming exec, kill).
- Auth rejection on missing/wrong secret on every endpoint, including WS upgrade.
- Reverse-proxy preserves WS upgrade and request body framing.
- File-store path-traversal rejection.
- Concurrent exec dedup (each call gets its own streamId; channels don't cross).

**Sidecar is Fly-only.** Docker keeps `docker exec`-based `exec`/`execStream` and direct host-loopback editor URLs. Forcing both providers through the sidecar adds a network hop and a shared-secret surface to local dev with no benefit; the `WorkspaceRuntimeCommand` interface is the seam. The `WorkspaceFileStore` interface (W11) is the seam for file operations.

### W8 — Terraform Fly module

New `deploy/terraform-fly/`:

- `main.tf` (Fly provider, GCS backend reusing the existing tf state bucket), `variables.tf`, `outputs.tf`.
- `app.tf` — two Fly apps: one for the control plane (`coderunner-control`), one for workspace machines (`coderunner-workspace`). Cleaner blast radius and token scoping than one app.
- `control-machine.tf` — single control plane machine, mounted volume, services on 443/80 (Fly handles TLS at the edge — no Caddy).
- `volume.tf` — the control plane data volume.
- `secrets.tf` — `BETTER_AUTH_SECRET`, OAuth credentials, `FRC_FLY_API_TOKEN` (deploy-scoped token for the *workspace* app, used by the control plane to spawn machines), Grafana Cloud credentials, `ADMIN_TOKEN`, `METRICS_TOKEN`. **No `WORKSPACE_SIDECAR_SECRET` at the Fly app level** — per-workspace sidecar secrets are generated at provision time and injected as per-machine env, not as Fly app secrets.
- `cert.tf` — custom domain + ACME cert.
- Workspace machines are **not** in Terraform — they're managed by the control plane at runtime, the same way Docker containers aren't in Terraform today.
- `deploy/terraform-fly/README.md` documenting bootstrap order (apps → secrets → control plane volume → deploy).

### W9 — Build, image, and deploy plumbing

- New `deploy/fly/control-plane.Dockerfile` — Bun-based image of the control plane app. Includes the Alloy binary and an entry script that starts Alloy in the background then runs migrations + the control plane.
- New `deploy/fly/fly.control.toml` — control plane app config (services, ports, mounts, health checks).
- New `deploy/fly/fly.workspace.toml` — workspace app config referencing the published workspace image and exposing the sidecar service on 6PN.
- Extend `.github/workflows/deploy.yml` with a `mode=fly` input that: validates tag, runs `bun run verify`, builds & pushes the workspace image and the new control-plane image to GHCR, applies `deploy/terraform-fly/`, `flyctl deploy -c deploy/fly/fly.control.toml`, `flyctl deploy -c deploy/fly/fly.workspace.toml`. GCE + CF Pages jobs stay unchanged.
- The Cloudflare Pages function (`deploy/cloudflare/functions/[[path]].ts`) is backend-agnostic — point `BACKEND_ORIGIN` at the Fly control plane hostname and CF mode works on top of Fly with no code change. Worth a one-line confirmation read.

### W10 — Docs

- New `docs/decisions/025-fly-deployment-mode.md` — the eight decisions above + the W4/W5/W7/W11/W12 sub-decisions (lifecycle hooks vs interface extension, additive table, sidecar-as-only-6PN-port, file-store abstraction, fleet rollout protocol, two-app split, never-auto-delete-volumes).
- New `docs/decisions/026-workspace-control-sidecar.md` — sidecar protocol, auth, reverse-proxy design, threat model.
- Update [README.md](README.md) to list three deployment modes.
- Update [docs/runbook.md](docs/runbook.md) with Fly-specific operator commands: tail logs via `flyctl`, inspect a workspace machine, manual recovery if a volume's host is unavailable, **`bun run fly:reconcile` for quarantined/orphaned resources**, **`bun run fly:rollout` for image upgrades (including `--resume` and `--recreate` semantics)**, and an explicit note that `bun run backup` continues to cover workspace data **by default** with `--skip-workspaces` as the explicit opt-out — Fly per-volume snapshots are the primary durability mechanism but the script-driven backup is complete by default.
- New `deploy/fly/README.md` walkthrough.

### W11 — `WorkspaceFileStore` abstraction

The control plane reads and writes workspace files in several namespaced subtrees today: `project/` (student source), `assets/` (AdvantageScope uploads), `logs/` (run logs), `backups/` (import backups). Caller sites: `storage.ts:82-108` (creates the dir tree, seeds template), [apps/control/src/imports.ts](apps/control/src/imports.ts) (git clone into `project/`, backup tarballs into `backups/`), [apps/control/src/app/assets.ts](apps/control/src/app/assets.ts) (AS Lite asset upload into `assets/`), [apps/control/src/runs.ts](apps/control/src/runs.ts) (run log write/read into `logs/`), [apps/control/src/app/admin-routes.ts](apps/control/src/app/admin-routes.ts) (disk-usage probe across the tree), and `scripts/backup.ts` / `scripts/restore.ts`. None of those paths work in Fly mode without a redirect.

- New `apps/control/src/workspace-file-store.ts` — interface `WorkspaceFileStore`. All methods take `(workspaceId, ns: "project"|"assets"|"logs"|"backups", relPath, …)`. Implementations reject absolute paths and `..` traversal.
  - `readFile(workspaceId, ns, relPath)`
  - `writeFile(workspaceId, ns, relPath, body)` — atomic (tempfile + rename)
  - `deleteFile(workspaceId, ns, relPath)`
  - `listDir(workspaceId, ns, relPath)`
  - `archive(workspaceId, ns, relPath)` → `ReadableStream` of tar bytes
  - `extract(workspaceId, ns, relPath, tarStream, mode: "replace"|"merge")` — `replace` removes target first (atomic via tempdir + swap); `merge` overlays.
  - `diskUsage(workspaceId, ns)` → bytes
  - `appendLog(workspaceId, ns, relPath, body)` — append-only helper used by `runs.ts` for log streaming
  - `seedTemplate(workspaceId)` — idempotent, seeds `project/` only if empty
- `LocalFileStore` — backed by `fs.promises`, rooted at `data/users/<workspaceId>/` with the namespace = subdir layout above. The existing on-disk layout doesn't change.
- `FlyFileStore` — calls the sidecar's file-store endpoints over 6PN with the per-workspace bearer header. Streaming archive/extract uses the body as a tar stream end-to-end (no buffering of full project).
- The file store is selected by the runtime factory (W2) alongside the runtime provider — they always pair.
- Update each call site to take a `WorkspaceFileStore` and route through it. The Docker mode behavior is unchanged (Local impl operates on the same paths it did before); Fly mode goes over the network. The audit checklist in W11's "Risks" section names every site.
- **Template seeding.** In Docker, `storage.ts` continues to create the dir tree and seed the template synchronously at workspace-row creation. In Fly, `provisionWorkspace` creates only Fly resources (the machine isn't running yet); the first `ensureWorkspaceRunning` calls `fileStore.seedTemplate(workspaceId)`, which is a no-op if `project/` is non-empty.
- **Backup/restore default-on with explicit stopped-machine lifecycle.** `bun run backup` continues to include workspace data **by default** (matches current behavior; flipping default off would silently produce incomplete backups for operators following muscle memory). Opt out with `--skip-workspaces`. Under Fly, workspace machines are pre-created stopped — the sidecar is unreachable until the machine is started. The Fly backup driver therefore runs a per-workspace lifecycle:
  1. **Start gate** — refuse to back up a workspace whose `repair_required = TRUE` or `rollout_in_progress = TRUE`. Record `status: "skipped_unsafe"` in the manifest with the reason; never invoke `startMachine`. The backup driver shares the same gate function as `ensureWorkspaceRunning` (W4 step 3); a centralized helper `canStartMachine(workspaceId) → {ok: boolean, reason?: string}` is the single source of truth.
  2. Record `previousState = getMachine(id).state` (started or stopped).
  3. If previously stopped, `startMachine` and wait for sidecar `/healthz` green (with a per-machine timeout).
  4. Stream all four namespaces (`project`, `assets`, `logs`, `backups`) via the sidecar `/files/archive` into the backup tarball.
  5. If `previousState === "stopped"`, `stopMachine`. If previously started, leave it running.
  6. On any failure inside steps 3–5: log to the backup manifest as `failed`, attempt to restore `previousState` (best-effort stop if we started it), continue to the next workspace. **Never abort the whole backup on one workspace's failure.**
  Concurrency bound: configurable, default 5 in parallel. The backup tarball includes a `manifest.json` listing `{workspaceId, status, durationMs, error?}` per workspace so operators can see partial coverage at a glance and re-run for the failures.
  Document that this is slower than control-plane-only backup, costs Fly start/stop API calls (subject to the rate limiter), and that Fly per-volume snapshots remain the primary durability mechanism. Snapshot retention/coverage is captured in decision 025 with explicit minimums (e.g. daily snapshots, 14-day retention, monthly restore-drill).
  Restore mirrors the lifecycle: for each workspace in the tarball, ensure the machine exists (via `provisionWorkspace` if reconstructing from the manifest), invoke `canStartMachine()`, start it, push the namespaced subtrees via sidecar `/files/extract?mode=replace`, then restore prior state. **Restore strictly respects the start gate** — workspaces in `repair_required` are skipped and recorded in the restore manifest with `status: "skipped_repair_required"`. There is **no override flag**: a `repair_required` workspace may have lost its volume mount (a documented cause from W12's update-mismatch branch), and restoring through that machine would write the student's recovered data to ephemeral storage instead of the volume — succeeding silently while the actual data stays unrestored. The correct operator path is `bun run fly:rollout --recreate <workspaceId> --i-understand-this-deletes-the-machine`, which rebuilds the machine attached to the existing volume; after `--recreate` clears `repair_required`, normal restore is allowed.
- New `apps/control/src/__tests__/workspace-file-store.test.ts` — both impls share the same conformance test suite (in-memory sidecar for Fly). The suite is also driven through actual admin/asset/import/run routes to catch missed call sites — a test failure means a route is still reaching into `fs` directly.

### W12 — Fleet image rollout (recoverable state machine)

`flyctl deploy` does not roll out to API-created Machines. Without explicit rollout logic, existing student machines would stay pinned to whatever image they were created with — old WPILib, old extensions, missing security fixes.

**Schema** (extends W5's `workspace_runtime_resources`). Persisted state is minimal; Fly itself is the source of truth for machine config + state.
- `provisioned_image_digest TEXT` — digest we asked Fly to create the machine with, written by `provisionWorkspace` at create time. **Not** treated as health-confirmed.
- `provisioned_image_revision TEXT` — human label paired with `provisioned_image_digest`.
- `provisioned_config_json TEXT` — normalized full machine config we asked Fly to create the machine with, written by `provisionWorkspace`. Used by `ensureWorkspaceRunning`'s first-start full-config verification (mirrors W12's `pending_target_config_json` semantics for the never-rolled-out case). Cleared at first-start commit.
- `current_image_digest TEXT` — last digest we **confirmed** healthy (machine started AND sidecar `/healthz` green AND `image_ref.digest` matched). Identity comparisons that determine "do we need to roll out?" use this. Only set by first-start commit (`ensureWorkspaceRunning` step 7) or by rollout commit (step 7). Never written by `provisionWorkspace`.
- `current_image_revision TEXT` — human label paired with `current_image_digest`. Operator-facing.
- `target_image_digest TEXT` — digest the operator asked for at lock acquisition. Equals `current_image_digest` when idle.
- `target_image_revision TEXT` — human label paired with `target_image_digest`.
- `pending_target_config_json TEXT` — the full normalized `targetConfig` (image, mounts, env, services, restart, guest, init/processes/checks, capabilities, metadata) that the current attempt **intends** to apply. Written **before** the Fly `POST /machines/{id}` so post-crash recovery has a durable expectation independent of whatever damaged state the live machine currently shows. Cleared on commit. Recovery compares the live machine against this stored expectation field-by-field; if `pending_target_config_json IS NULL` AND the observed digest matches target, the provider cannot prove the config is intact and **fails closed to `repair_required`** rather than re-deriving expectations from live state.
- `last_verified_target_hash TEXT` — SHA256 of `pending_target_config_json` after step 4's full-equality verification passes. Step 5's start phase will not run unless this matches `hash(pending_target_config_json)`.
- `rollout_in_progress BOOLEAN` — owns-the-lock flag.
- `rollout_attempt_token TEXT` — random UUID generated at lock acquisition. Identifies the rollout attempt that currently owns the DB lock.
- `fly_machine_lease_nonce TEXT` — Fly-side machine lease nonce returned by `POST /v1/apps/{app}/machines/{id}/lease`. **Every Fly mutation in steps 3–7 passes this nonce; Fly rejects mutations whose nonce doesn't match the live lease.** This is the real fence against delayed mutations from a stolen-lease former owner — Fly enforces it, not us.
- `fly_machine_lease_expires_at TEXT` (ISO8601) — copy of the lease's expiry as returned by Fly. Used to schedule renewals before expiry.
- `rollout_lease_until TEXT` (ISO8601) — DB-side lease, every rollout step extends to `NOW() + 60s` (DB heartbeat). Always kept ≤ the Fly-side `fly_machine_lease_expires_at`. Lock acquisition accepts rows whose DB lease has expired AND whose Fly lease has expired (or doesn't exist).
- `last_rollout_error TEXT` — null when healthy or when a resume has actively claimed the slot. Set only at the point of recording a terminal failure.
- `repair_required BOOLEAN` — set when post-update verification (step 4) finds a state we cannot safely recover from. The workspace is excluded from automation; only `bun run fly:rollout --recreate` or `bun run fly:reconcile --clear-repair` clears it.
- `rollout_attempt_count INTEGER`, `rollout_started_at TEXT`, `rollout_finished_at TEXT`.

**Lease nonce is an HTTP header, not a JSON body parameter.** Per Fly docs (https://fly.io/docs/machines/api/machines-resource/#update-a-machine), leased Machine operations carry the nonce in the `fly-machine-lease-nonce` request header. The Fly client (W3) wires it as a header on every mutation while a lease is held; never as a body field. Plan and tests assume the header contract.

**Two-step ownership: Fly lease is the source of truth, DB row is a cache.** Because the Fly lease is what actually fences delayed mutations, takeover MUST be gated on a fresh `acquireMachineLease` call — not on cached `fly_machine_lease_expires_at`. The cache can be stale in the exact crash window (Fly lease acquired, DB write failed). Ownership protocol:

1. **Probe DB row.** Read the row. If `repair_required = TRUE` → return `RepairRequiredError`. If `rollout_in_progress = TRUE` AND `rollout_lease_until > now()` → another live attempt is heartbeating; return `RolloutLockHeldError` without touching Fly. **Early no-op returns** (skipped under `--force-adopt`):
   - If `current_image_digest === targetDigest` AND `pending_target_config_json IS NULL` AND `rollout_in_progress = FALSE` → already healthy at target; return without acquiring any lock and without calling Fly.
   - If `current_image_digest IS NULL` AND `provisioned_image_digest === targetDigest` AND `rollout_in_progress = FALSE` → freshly provisioned at the target digest, awaiting first start. No rollout work needed; the next `ensureWorkspaceRunning` does the first-start verification + commit. Return without lock.
   These are the steady-state paths — the vast majority of CLI selector hits land here.
2. **Acquire fresh Fly lease.** Call `POST /v1/apps/{app}/machines/{id}/lease` (TTL 120s). If Fly returns conflict (a live lease is held) → return `RolloutLockHeldError` regardless of what the DB cache said. Fly's response is authoritative.
3. **CAS-claim the DB row** with the freshly-acquired `flyNonce` and `flyExpiresAt`. **Critically, this UPDATE does NOT clear `pending_target_config_json`, `target_image_*`, or `last_verified_target_hash`** — any unresolved prior attempt's recovery state survives.
```
UPDATE workspace_runtime_resources
   SET rollout_in_progress = TRUE,
       rollout_attempt_token = :callerToken,
       fly_machine_lease_nonce = :flyNonce,
       fly_machine_lease_expires_at = :flyExpiresAt,
       rollout_started_at = CURRENT_TIMESTAMP,
       rollout_lease_until = datetime('now', '+60 seconds'),
       rollout_attempt_count = rollout_attempt_count + 1
 WHERE workspace_id = :id
   AND repair_required = FALSE
   AND (rollout_in_progress = FALSE
        OR rollout_attempt_token = :callerToken
        OR rollout_lease_until < datetime('now'))
```
If the CAS finds 0 rows (a concurrent caller acquired between step 1 and 3), release the Fly lease via `DELETE /lease` and return `RolloutLockHeldError`.
4. **Resolve prior attempt, if any.** If the row still has `pending_target_config_json IS NOT NULL` from a previous attempt:
   - `getMachine`. Verify the live config against the persisted `pending_target_config_json`'s expectation using step 4's full-equality check.
   - If verified → run step 5 (Start, with the persisted target) → step 6 → step 7 (Commit, advancing `current_image_*`). This completes the prior attempt before any new target is considered.
   - If verification fails → **route through the same containment routine the update phase uses** (step 4's "Anything else" branch). Specifically: if `getMachine` shows the machine is running (Fly may have auto-launched the malformed config before the prior owner crashed), `stopMachine(lease_nonce=:flyLeaseNonce)` and `waitForState("stopped")`. If stop fails or state is uncertain → retain the Fly lease + DB lock, set `containment_failure`, return. Only after confirmed stopped: set `repair_required = true`, persist error, release Fly lease, return. Recovery and immediate-update verification failures share one containment path so no recovery branch can leave a malformed machine running.
   - Either way, `rolloutWorkspace` returns to the caller. The CLI then re-invokes with the operator's currently configured target, which (because we just resolved or quarantined the prior attempt) sees `pending_target_config_json IS NULL` and starts fresh.
5. **Initialize for new target** (only if `pending_target_config_json IS NULL`). CAS-write `target_image_digest`, `target_image_revision`, leave `pending_target_config_json = NULL` (it gets written in step 4 of the rollout phases, just before the POST). Proceed to "Observe and short-circuit" (rollout phase 2).

**Heartbeats.** Every rollout step re-issues a CAS that extends `rollout_lease_until = NOW() + 60s` AND refreshes the Fly lease via `POST /lease` with the existing nonce (Fly extends the same lease). Both must succeed; if either fails (DB CAS finds 0 rows OR Fly returns 404/conflict on refresh), the current attempt aborts immediately without further Fly mutations. **Bounded request lifetimes:** any single Fly mutation that doesn't complete within 30s is canceled and retried; an outstanding request never outlives the lease.

**Failure / commit cleanup.** Release the Fly lease via `DELETE /v1/apps/{app}/machines/{id}/lease` on every terminal exit (commit, terminal error, lock-loss). If release fails (network), Fly's TTL still cleans it up at most 120s later.

**Resume protocol.** `--resume <workspaceId>` performs the same two-step ownership flow as ordinary acquisition (fresh `POST /lease` first, then CAS-claim the DB row), but with a tighter predicate that only matches the resumable state:
1. Probe: row must be `rollout_in_progress = TRUE` AND `last_rollout_error IS NOT NULL` AND `repair_required = FALSE`. If not, return `RolloutNotResumableError`.
2. `POST /v1/apps/{app}/machines/{id}/lease`. If Fly returns conflict → `RolloutLockHeldError` (a live attempt is still running; resume cannot displace it without operator force-adopt).
3. CAS:
```
UPDATE workspace_runtime_resources
   SET rollout_attempt_token = :callerToken,
       last_rollout_error = NULL,                  -- claim the slot
       fly_machine_lease_nonce = :flyNonce,
       fly_machine_lease_expires_at = :flyExpiresAt,
       rollout_lease_until = datetime('now', '+60 seconds'),
       rollout_started_at = CURRENT_TIMESTAMP,
       rollout_attempt_count = rollout_attempt_count + 1
 WHERE workspace_id = :id
   AND rollout_in_progress = TRUE
   AND last_rollout_error IS NOT NULL
   AND repair_required = FALSE
```
This UPDATE **does not clear** `pending_target_config_json` / `target_image_*` / `last_verified_target_hash` — those are the recovery state the resume needs to continue. The cleared `last_rollout_error` is what fences a concurrent `--resume` (its precondition `last_rollout_error IS NOT NULL` no longer matches).

If the CAS finds 0 rows after a successful Fly lease acquire, release the Fly lease and return `RolloutLockRotatedError`.

**`--force-adopt` is an acquisition mode of `rolloutWorkspace`, not a standalone verb.** It's a flag on the rollout CLI (`bun run fly:rollout --workspace <id> --force-adopt`) that tells the ownership protocol "claim this row regardless of the current DB heartbeat or token, as long as Fly grants us a fresh lease". The same call **immediately continues** into the rollout flow under the new ownership — including the prior-expectation recovery step. There is no operator state in which `--force-adopt` claims a row and then leaves it stuck waiting for the operator to do something else.

Concretely, force-adopt modifies only the ownership protocol's step 1 (probe DB row): instead of rejecting on `rollout_in_progress = TRUE AND rollout_lease_until > now()`, force-adopt skips that check. Steps 2–4 (acquire Fly lease, CAS-claim DB row preserving recovery state, resolve prior attempt) are identical. Force-adopt also skips the early no-op return (it always exercises the recovery resolution). The CAS predicate becomes:
```
   AND (rollout_in_progress = TRUE)   -- claim any in-progress row
   AND repair_required = FALSE
```
Fly's `POST /lease` is still the actual ownership gate: if Fly returns conflict, force-adopt gets `LiveFlyLeaseError` with the message "live Fly machine lease held; either wait for its TTL to expire or cancel it explicitly via `flyctl machine clear-lease <machineId> -a <app>`". On Fly-success, the CAS claims the row, and the flow proceeds into prior-expectation resolution (step 4 of the ownership protocol) under the new token. The operator sees the rollout finish or quarantine as if it were a normal `rolloutWorkspace` call.

A different operator running ordinary `--resume` against an already-claimed (or zombie) row sees `RolloutLockRotatedError` and is prompted to either wait for the lease to expire (then plain `rolloutWorkspace` succeeds) or to `--force-adopt`. No automatic possession by reading shared state.

**Image identity is digest-pinned.** Docker tags are mutable; comparing `config.image` as a string doesn't prove identity. The operator's build pipeline (W9) produces an immutable `sha256:…` digest at deploy time. Config exposes two paired values:
- `config.fly.flyWorkspaceImageReference` — full pinned reference, e.g. `ghcr.io/owner/coderunner-workspace@sha256:abc123…`. This is what gets written to `config.image` on every machine create or update.
- `config.fly.flyWorkspaceImageRevision` — human-readable label (e.g. `v2.4.1`) used only in the `frc-image-revision` annotation metadata and in operator-facing CLI output.

Identity comparisons in this section always use the digest (via Fly's `image_ref.digest` field on `getMachine`), never the tag string.

**`FlyMachinesRuntimeProvider.rolloutWorkspace(workspaceId, targetReference)`** — fully observed-state-driven; safe to call repeatedly. Only does in-place update. No automatic recreate. `targetReference` is the digest-pinned image reference (`<repo>@sha256:…`) from `config.fly.flyWorkspaceImageReference`; the operator-facing label (`targetRevision`) is stored separately.

**Lock first — always.** Before any other action (including the no-op fast path), acquire the lock with the atomic UPDATE described above. This eliminates the race where a concurrent caller's "matching image + healthy" shortcut would otherwise clear another rollout's active lock.

1. **Acquire lock** via the atomic UPDATE above. On 0 changes → return `RolloutLockHeldError` or `RepairRequiredError`. Now the caller owns the row with `callerToken`. From here on, every DB write conditionally requires `rollout_attempt_token = :callerToken`.
2. **Observe.** (The simple "already at target, no work" case was handled by the ownership protocol's early no-op return before we even acquired the lease. By this point we own the lock and know there's recovery or fresh work to do.) `getMachine`. Extract `liveDigest = getMachine().image_ref.digest` and `liveState`. Probe sidecar `/healthz` only if `liveState === "started"`.
   - If `liveDigest === targetDigest` AND `pending_target_config_json IS NOT NULL` AND `last_verified_target_hash === sha256(pending_target_config_json)` AND `liveState === "started"` AND sidecar healthy → already at target, verified, healthy (matches "crashed after start, before commit" recovery). Commit (step 7).
   - If `liveDigest === targetDigest` AND `pending_target_config_json IS NOT NULL` AND verified hash matches but state stopped/unhealthy → jump to step 5 (Start) or step 6 (Health).
   - If `liveDigest === targetDigest` AND `pending_target_config_json IS NOT NULL` AND `last_verified_target_hash` is NULL → crashed after POST before verification ran. Re-run step 4's verification against the live machine **using the persisted `pending_target_config_json` as the expectation**, not a fresh derivation from current live state (which may already be damaged).
   - If `liveDigest === targetDigest` AND `pending_target_config_json IS NULL` AND `current_image_digest IS NULL` AND `provisioned_image_digest === targetDigest` → this is the freshly-provisioned-but-never-started case. The rollout pre-check defers to `ensureWorkspaceRunning`'s first-start verification path: release the Fly lease and return without action. The next user access triggers first-start verification + commit, which then advances `current_image_digest`.
   - If `liveDigest === targetDigest` AND `pending_target_config_json IS NULL` AND `current_image_digest !== targetDigest` AND `provisioned_image_digest !== targetDigest` → ambiguous: we observe the target digest in Fly but have no durable record of what the intended config was (DB has no committed-healthy record AND we didn't provision this digest). **Fail closed to `repair_required`**; do not start, do not commit.
   - If `liveDigest !== targetDigest` → walk every phase (stop, update, start, health, commit).
3. **Stop phase.** If `currentState !== "stopped"`: `stop` + `waitForState("stopped")`. Failure → CAS-update `last_rollout_error`, clear `rollout_in_progress` (CAS on `callerToken`), return. Machine remains on the old image; `current_image_revision` is unchanged.
4. **Update phase.** Fly's `POST /v1/apps/{app}/machines/{id}` is a **full-config replace** and **auto-starts a stopped machine unless `skip_launch: true` is passed** (https://fly.io/docs/machines/api/machines-resource/#update-a-machine). Without `skip_launch`, a config that fails our verification could already be running before we notice. Protocol:
   - `getMachine` to fetch the full current config; snapshot it as `previousConfig`.
   - Build `targetConfig` by deep-cloning `previousConfig` and changing **only** `image` (set to `targetReference`, the digest-pinned `<repo>@sha256:…`) and the `frc-image-revision` annotation tag (set to the human label `targetRevision`). Every other field — mounts, env (including `WORKSPACE_SIDECAR_SECRET`, `VSCODE_BASE_PATH`, `FRC_WORKSPACE_ID`, `FRC_CONTROL_PLANE_6PN`), services, restart policy, capabilities (`CAP_NET_ADMIN`), guest sizing, init, processes, checks, metadata tags `frc-coderunner-workspace` and `frc-workspace-id` — is carried over verbatim.
   - Normalize `targetConfig` to a canonical JSON form. **Persist it durably first** via a CAS on `:callerToken`: `UPDATE … SET pending_target_config_json = :json, last_verified_target_hash = NULL WHERE workspace_id = :id AND rollout_attempt_token = :callerToken`. This must happen **before** the Fly POST so that a crash between the POST and verification leaves us a durable expectation to recover against. If the CAS finds 0 rows, ownership was lost — abort without POSTing.
   - `POST /machines/{id}` with body `{ config: targetConfig, skip_launch: true }` and the **header `fly-machine-lease-nonce: <flyLeaseNonce>`**. The `skip_launch` prevents Fly from launching the (possibly malformed) new config; the header makes Fly reject the request if a takeover has already invalidated our lease.
   - Immediately `getMachine` to fetch `appliedConfig` and assert `getMachine().state === "stopped"` (the no-launch invariant). If state advanced beyond stopped, treat it as the catch-all failure case below.
   - **Mandatory full-equality verification — against the persisted `pending_target_config_json`, never against a fresh derivation from live state.** Normalize `appliedConfig`, compare with the persisted JSON for **exact equality of every preserved field**: mounts, **services**, **restart policy**, **guest sizing**, **init/processes/checks**, capabilities, the full env map (no extra keys, no missing keys, no changed values), **both metadata tags `frc-coderunner-workspace` and `frc-workspace-id`** (exact match), and `image_ref.digest === expectedDigest(targetReference)`. Image and `frc-image-revision` are the only documented diffs from `previousConfig`.
   - Branch on verification outcome:
     - **Verified target** (every preserved field matches AND digest matches): CAS-write `last_verified_target_hash = sha256(pending_target_config_json)` (held under `:callerToken`), heartbeat both leases, continue to step 5.
     - **Verified previous** (Fly rejected the change and reverted; entire applied config is byte-identical to `previousConfig` including the original image): record the error but **keep both locks**. Heartbeat them, then `start` (with `lease_nonce`) on the old image, `waitForState("started")`, sidecar `/healthz`. Only after the old-image recovery is observed running and healthy: CAS-set `last_rollout_error = "rejected by Fly, reverted to previous"`, release Fly lease, CAS-clear `rollout_in_progress` and `pending_target_config_json` (still using `:callerToken`). Releasing the lock before the recovery start completed would let a new rollout sneak in and write a fresh config that our pending start launches; holding the lock until observed-healthy closes that race.
     - **Anything else** (partial application, any preserved-field mismatch, ambiguous response, network error after POST without a clean read, or machine no longer stopped): **do not issue a new start**. If `getMachine` shows the machine is currently running (the "Fly auto-launched our malformed config" case), **first stop it with the lease nonce** — `stopMachine(lease_nonce=:flyLeaseNonce)` and `waitForState("stopped")`. If stop fails or `getMachine` is uncertain, **retain the Fly lease and DB lock** (do not release): emit `runtime.containment_failure` with high severity, persist `last_rollout_error = "containment failure — machine may be running unsafe config, lease held for operator inspection"`. Otherwise (machine confirmed stopped): CAS-set `repair_required = true`, `last_rollout_error = "post-update config mismatch — manual repair required"`, leave `rollout_in_progress = true`, leave `pending_target_config_json` populated, then release the Fly lease normally. Reconcile CLI surfaces both `repair_required` and `containment_failure` categories; operator handles them with elevated urgency for the latter. Step 4 is the only path that can set `repair_required` or `containment_failure`.
5. **Start phase.** Precondition: `pending_target_config_json IS NOT NULL` AND `last_verified_target_hash === sha256(pending_target_config_json)` for this attempt. If the precondition fails (e.g. we entered via the short-circuit path after a crash), loop back to step 4's verification (using the persisted expectation) before proceeding. Then: heartbeat both leases, `POST /machines/{id}/start` with the `fly-machine-lease-nonce` header + `waitForState("started")`. Failure → CAS-update `last_rollout_error`, **leave `rollout_in_progress=true`** and `pending_target_config_json` populated so the next call resumes from this point with the durable expectation intact. (We intentionally do NOT clear the lock here; the workspace is in a half-state — new image, not running — and needs explicit `bun run fly:rollout --resume` from an operator with the matching token, or wait for the lease pair to expire.)
6. **Health phase.** Heartbeat both leases, then sidecar `GET /healthz` over 6PN with the workspace's bearer, with timeout + backoff retries. Failure → same as step 5 (lock held with token, error recorded, awaits resume or lease expiry).
7. **Commit.** CAS on `callerToken`: set `current_image_digest = targetDigest`, `current_image_revision = targetRevision`, clear `pending_target_config_json`, clear `last_verified_target_hash`, clear `last_rollout_error`, clear `rollout_in_progress`, clear `rollout_attempt_token`, clear `rollout_lease_until`. Release the Fly lease via `DELETE /v1/apps/{app}/machines/{id}/lease`; on success clear `fly_machine_lease_nonce` and `fly_machine_lease_expires_at`. Set `rollout_finished_at`. Invalidate the state cache for this workspace. If the CAS finds 0 rows (someone else `--force-adopt`ed or stole the lease during our work), log and return — they own the row now.

**Resume semantics.** Every call to `rolloutWorkspace` always reads Fly's observed state first and decides where to enter the sequence above. The persisted `rollout_in_progress` flag exists only to prevent concurrent overlapping rollouts and to keep `last_rollout_error` visible until an operator handles it. There are no "intent" states like `stopping`/`updating` in the DB — those would be inconsistent across crashes. Concretely:
- Crash anywhere: next call observes Fly state, walks steps 2→6 from whichever is needed.
- Crashed after stop succeeded but before recording anything: next call observes `state=stopped, image=old`, picks up at step 3.
- Crashed after update succeeded but before start: next call observes `state=stopped, image=new`, picks up at step 4.
- Crashed after start succeeded but before health check: next call observes `state=started, image=new, health=?`, picks up at step 5.
- Machine running new image and healthy but `rollout_in_progress=true` because we crashed before commit: pre-check at the top catches this and clears the lock.

**No automatic recreate-with-volume.** Operator-explicit only, behind `bun run fly:rollout --recreate <workspaceId> --i-understand-this-deletes-the-machine`. Recreate uses W4's provisioning path (machine missing, volume present).

**`scripts/fly-rollout.ts`** (and `bun run fly:rollout`):
- Default mode: read the **operator's currently-configured** `targetDigest` (parsed from `config.fly.flyWorkspaceImageReference`). Selector:
  ```
  SELECT workspace_id FROM workspace_runtime_resources
   WHERE repair_required = FALSE
     AND (
       (current_image_digest IS NULL AND provisioned_image_digest != :operatorTargetDigest)
                                                       -- never confirmed healthy AND provisioned at a different digest
       OR (current_image_digest IS NOT NULL AND current_image_digest != :operatorTargetDigest)
                                                       -- previously healthy at a different digest
       OR rollout_in_progress = TRUE                    -- in flight or zombie
       OR last_rollout_error IS NOT NULL                -- awaiting resume
     )
  ```
  A workspace with `current_image_digest IS NULL AND provisioned_image_digest == :operatorTargetDigest` is NOT selected — first-start verification through `ensureWorkspaceRunning` will commit it. Calls `rolloutWorkspace(workspaceId, operatorTargetReference)`. Rate-limited against Fly write budget. Concurrency default 2. Per-workspace status to stdout. `repair_required` rows are listed by `bun run fly:reconcile` instead.
- `--dry-run`, `--limit N`, `--workspace <id>`, `--resume <id>` (acts only on rows where `rollout_in_progress=true` AND `last_rollout_error IS NOT NULL` AND `repair_required=false`; performs the resume protocol then continues into rollout), `--force-adopt` (flag on `--workspace <id>` — acquisition mode that claims any in-progress row whose Fly lease is releasable, then immediately continues into rollout/recovery under the new token), `--recreate <id> --i-understand-this-deletes-the-machine` (also the only way to clear `repair_required` from this CLI).

**`scripts/fly-reconcile.ts`** (and `bun run fly:reconcile`) — separate from rollout. Lists three categories that need operator attention: (a) quarantined machines/volumes from W4 reconciliation, (b) rows with `repair_required = true` from a failed rollout post-write verification, (c) Fly resources tagged but absent from DB (orphan candidates). Offers `--import <id>` (recreate DB row from `frc-workspace-id` tag, recovering `sidecar_secret` from machine env), `--delete <id> --confirm <id>` (operator types the workspaceId twice), or `--clear-repair <id> --confirm <id>` (operator-acknowledged manual fix in Fly; clears `repair_required` so rollout can re-attempt). Never deletes without double confirmation.

**Tests** `apps/control/src/fly/fly-rollout.test.ts` (drive a `FakeFlyApiClient` whose machine state and image_revision_tag are observable):
- No-op when revision matches and sidecar is healthy.
- Successful in-place update walks all six phases.
- Failure at step 2 (stop) → machine still on old image, `last_rollout_error` set, lock cleared.
- Failure at step 3 (update) → machine restarted on old image, `last_rollout_error` set, lock cleared.
- Failure at step 4 (start) → `last_rollout_error` set, lock **held**, next call (`--resume`) picks up at step 4.
- Failure at step 5 (sidecar health) → same as step 4 — lock held, awaits resume.
- **Crash simulation at every boundary**, asserting next call observes Fly state and resumes correctly **without ever advancing `current_image_revision` to an unhealthy value**:
  - Crash after `stop` succeeds, before any DB write → next call observes `config.image=old, state=stopped` and walks 3→6. `current_image_revision` unchanged.
  - Crash after `update` succeeds, before start → next call observes `config.image=target, state=stopped` and walks 4→6. `current_image_revision` unchanged until step 6.
  - Crash after `start` succeeds, before any DB write → next call observes `config.image=target, state=started`, runs health check, commits. `current_image_revision` advances only at commit.
  - Crash after health succeeds, before commit → next call's pre-check sees `config.image=target, state=started, healthz=green`, commits. `current_image_revision` advances exactly once.
- **Mutable-tag-cannot-advance-revision:** mutate the machine's `frc-image-revision` metadata tag externally without changing `config.image` / `image_ref.digest`. Next call must **not** advance `current_image_revision` and must continue to the update phase. (This replaces the earlier drift-catch test, which was wrong. No test asserts the opposite behavior anywhere in the suite.)
- **Digest-changed-under-same-tag:** start the machine on `repo:v2.4@sha256:OLD`, rebuild and repush so `repo:v2.4@sha256:NEW` is the new content for the same tag. Rollout's identity comparison uses digest, not tag — so the workspace is correctly flagged as needing update even though the tag string is unchanged.
- **`skip_launch` invariant:** assert every `POST /machines/{id}` issued by rollout includes `skip_launch: true`. Add a fault test where the fake Fly is configured to "auto-start on update if skip_launch missing"; assert the test fails if `skip_launch` is omitted (regression guard).
- **Full-config preservation + post-write verification:** the fake Fly returns a populated existing config with mounts, env (multiple keys), services, restart policy, guest sizing, init, both metadata tags. Assert the POSTed config carries every field with only `image` + `frc-image-revision` changed. Then simulate the fake Fly:
  - Dropping the mount → verification catches mismatch → `repair_required = true`, no `start` call.
  - Adding an unexpected env var → same.
  - Changing restart policy → same.
  - Removing `frc-coderunner-workspace` metadata → same.
  - Returning the entire previous config (rollback case) → `last_rollout_error`, `start` on old image, lock cleared.
  - Returning a config with state=`started` after update (Fly auto-launched) → treated as verification failure → `repair_required`.
- **Repair-required is sticky:** a workspace with `repair_required = true` is rejected by `--resume` (returns `RepairRequiredError`) and by the default CLI selector; only `--recreate <id> --i-understand…` or `bun run fly:reconcile --clear-repair <id> --confirm <id>` clears it.
- **Atomic-lock contention:** two concurrent `rolloutWorkspace` calls with different `targetReference`s — exactly one acquires the lock, the other returns `RolloutLockHeldError` without touching Fly.
- **Lock-first invariant:** a concurrent caller observing the matching digest + healthy state **cannot** clear another rollout's lock — its CAS includes `(rollout_in_progress = false OR rollout_attempt_token = :callerToken OR rollout_lease_until < now)` and fails when another live attempt holds the lease.
- **Zombie-row recovery via lease expiry:** simulate a crash that left `rollout_in_progress=true`, `last_rollout_error IS NULL`, `rollout_lease_until` in the past. A fresh `rolloutWorkspace` call (no flags) acquires the lock — its CAS matches the expired-lease branch. Test asserts no operator intervention was needed.
- **Zombie-row recovery via `--force-adopt`:** same crashed state; `--force-adopt` claims the row immediately without waiting for lease expiry.
- **Resume claims the slot:** `--resume` succeeds, after which a second `--resume` returns `RolloutLockRotatedError` (because `last_rollout_error IS NULL` now). Even if the second resume reads the new token, its CAS still fails.
- **Resume token rotation:** two concurrent `--resume <id>` calls — exactly one wins the CAS and clears the error slot; the other returns `RolloutLockRotatedError`.
- **`--force-adopt` succeeds without prior token:** stuck attempt scenario; assert one CAS-rotation succeeds even when the caller has no knowledge of the existing token.
- **Verified-previous keeps lock through recovery:** simulate Fly reverting the update. The provider does NOT clear `rollout_in_progress` until after the old-image restart is observed healthy. A second `rolloutWorkspace` attempted during the recovery window sees `RolloutLockHeldError`. Without this, a recovery start could launch a freshly-written config.
- **Crash-after-POST-before-verify with corrupted config:** simulate the fake Fly applying only a subset of fields (drop the mount), the control plane crashing before verification ran. The DB has `pending_target_config_json` (full intended config) and `last_verified_target_hash = NULL`. Next call observes `currentDigest === targetDigest` and re-runs verification **against the persisted JSON, not against live state**. Verification correctly fails → `repair_required = true`, no `start` call.
- **Ambiguous-digest-no-expectation fail-closed:** seed a state where the live machine has `image_ref.digest === targetDigest` but `pending_target_config_json IS NULL` (e.g. operator manually mutated the machine outside the rollout flow, or a partial DB restore). Provider must NOT start; must set `repair_required = true`. Without this, a manually-mutated machine could be falsely declared healthy.
- **Step 5 precondition guard:** force entry into step 5 with `last_verified_target_hash` null. Assert the provider loops back to step 4's verification rather than starting unverified.
- **Stale-Fly-mutation rejection:** simulate a delayed `POST /machines/{id}` from a previous owner whose lease has been released. The fake Fly enforces the **`fly-machine-lease-nonce` header** contract → the stale POST returns 412/409. The new owner's progression is unaffected.
- **Lease nonce in header, not body:** assert the Fly client never serializes `lease_nonce` into the JSON body or query string for any mutating endpoint. Tests fail if a regression sends it in the body. Includes update, start, stop, and release.
- **Heartbeat extends Fly lease via header:** long-running step (e.g. `waitForState` taking >TTL/2) triggers `refreshMachineLease` with the existing nonce in the header. Assert no takeover succeeds during the window.
- **`--force-adopt` actually probes Fly:** the cached DB `fly_machine_lease_expires_at` is null (crash window) but Fly's lease is still live. `--force-adopt` calls `POST /lease`, Fly returns conflict, force-adopt refuses with `LiveFlyLeaseError`. After the Fly TTL expires, force-adopt's `POST /lease` succeeds, then it CAS-claims the DB row preserving recovery state.
- **`--force-adopt` continues into rollout immediately:** assert that after a successful force-adopt acquisition, the same call continues into the rollout protocol (prior-expectation resolution → step 5 / 7 / repair_required as appropriate). The CLI exits when the rollout finishes or the state stabilizes — there's no "claimed but stuck" interim state requiring a second operator command. Test against a zombie row (`rollout_in_progress = true`, `last_rollout_error IS NULL`, leases expired): one `--force-adopt --workspace <id>` invocation either commits, errors, or sets `repair_required` — never just claims and exits.
- **Takeover preserves recovery state:** ordinary acquisition reclaiming an expired-lease row does NOT clear `pending_target_config_json` / `target_image_*` / `last_verified_target_hash`. The new attempt's first action is to resolve any unresolved prior expectation (verify against the persisted target config). Only after the prior is resolved or quarantined does a fresh target initialize.
- **Crash-then-new-target sequence:** simulate attempt A crashes mid-update with `pending_target_config_json` for digest A. Both leases expire. Operator bumps configured target to digest B. New `rolloutWorkspace` call acquires the lock, finds `pending_target_config_json` for A, verifies A against the live machine. If verification succeeds → commits A first, returns; the next CLI tick rolls forward to B. If verification fails → sets `repair_required = true`. Either way, the new target is never silently overlaid on damaged state.
- **CLI selector covers digest drift under unchanged label:** seed a workspace with `current_image_digest = OLD_DIGEST` and `current_image_revision = "v2.4"`. Operator rebuilds to `NEW_DIGEST` under the same `v2.4` label. The selector lists this workspace (because `current_image_digest != operatorTargetDigest`) even though the revision label matches.
- **CLI selector:** seed a mix of workspaces (idle/healthy, drifted digest, in-progress with token, errored-but-resumable, repair-required, never-rolled-out) and assert the default selector iterates only the non-idle non-repair-required ones; repair-required workspaces appear in `bun run fly:reconcile` output instead.
- **Lease heartbeat prevents takeover during active work:** simulate two `rolloutWorkspace` calls staggered by 10s. The first holds the lock, runs steps that heartbeat the lease. The second's lock acquisition fails (unexpired lease, different token, not `--force-adopt`). After the first commits and clears, a third call succeeds.
- Partial-fleet failure isolation (one workspace failure doesn't stop the loop in the CLI).
- `--recreate` requires both flags (`--recreate <id>` and `--i-understand-…`); single flag → no action.

### W13 — In-guest network isolation (firewall)

The threat model says student Java code is untrusted. The "sidecar is the only first-party 6PN-bound port" rule alone is unenforceable, because a student can bind their own ServerSocket to `fly-local-6pn`. Without an in-guest firewall, every workspace machine is mutually reachable on every port a student chooses to open.

- **Capability.** Workspace machine config grants `CAP_NET_ADMIN` to the **machine entrypoint** (Fly passes capabilities via the machine `init` config). The entrypoint drops it before exec'ing into the s6 supervisor.
- **PID-1 entrypoint wrapper.** Constraining sibling s6 services requires that the bounding-set drop happen in an ancestor of the supervisor, not a peer of it. The image therefore uses a thin wrapper as PID 1:
  - `containers/code/entrypoint.sh` runs as root, PID 1.
  - It performs the firewall setup and capability drop (steps below), then `exec /init` — the linuxserver/openvscode-server s6-overlay entrypoint — inheriting the dropped bounding set.
  - The `Dockerfile` sets `ENTRYPOINT ["/usr/local/bin/frc-entrypoint"]` (script copied in via Dockerfile), preserving the existing `CMD` (`/init`) under it.
  - Because PID 1 has dropped `CAP_NET_ADMIN` from the bounding set before exec'ing the supervisor, every descendant — `/init`, every s6 service, the sidecar's exec spawns, the editor terminal, all student processes — inherits a kernel-enforced inability to ever regain `CAP_NET_ADMIN`. `PR_CAPBSET_DROP` is irreversible across the process tree.
- **What the entrypoint does, in order:**
  1. Resolves the 6PN interface (typically `eth0` on Fly; discover via `ip -6 addr show scope global` matching `fdaa::/16` to be robust).
  2. Installs an nftables ruleset that:
     - **INPUT on 6PN**: ACCEPT `tcp dport 8787` (sidecar), ACCEPT established/related (return traffic for outbound), DROP all else. Loopback INPUT is unaffected.
     - **OUTPUT on 6PN**: ordered, first-match:
       1. ACCEPT UDP and TCP `dport 53` to **`fdaa::3`** (Fly's per-org private DNS resolver, served on 6PN — without this, `/etc/resolv.conf` lookups fail and Gradle/Maven downloads break).
       2. ACCEPT to the control plane machine's 6PN address (read from env `FRC_CONTROL_PLANE_6PN`, set by `provisionWorkspace`).
       3. ACCEPT outbound whose destination is **not** in `fdaa::/16` (public internet via Fly's NAT).
       4. DROP everything else (i.e. drop any 6PN traffic to other machines in the org).
     - Loopback unaffected so the sidecar can reverse-proxy to 127.0.0.1:3000 etc.
     - If Fly later adds other required intra-6PN services (metadata, telemetry endpoints), they're added to this allowlist explicitly — fail-closed by default.
  3. Persists the rules using `nft -f` and verifies them via `nft list ruleset`.
  4. **Drops `CAP_NET_ADMIN` from the bounding set** via `capsh --drop=cap_net_admin --print -- -c 'true'` to verify, then sets it for real via `prctl(PR_CAPBSET_DROP, CAP_NET_ADMIN)`. Bounding-set drop is irreversible; no descendant can ever regain the capability, regardless of UID escalation or future `setuid` binaries.
  5. `exec /init`. Because step 4 ran in PID 1 before this exec, the supervisor and every service it starts inherits the dropped bounding set.
- **Non-root UID for user-reachable processes.** The sidecar and openvscode-server run as the linuxserver base image's existing non-root account (`abc` in the current image, via the s6 `s6-setuidgid` mechanism the image already uses — confirm the exact uname before W13 lands). Sidecar exec spawns inherit that UID. Even if a future Dockerfile change re-runs a service as root, step 4's bounding-set drop still prevents `CAP_NET_ADMIN` re-acquisition.
- **Failure mode.** If the entrypoint fails any of steps 1–4 (nftables not available, can't discover the 6PN interface, can't drop the bounding capability, can't verify the ruleset), it `exit 1`'s before exec'ing `/init`. PID 1 dies → Fly's machine supervisor reports the machine as crashed → it does not get traffic. A workspace that can't isolate must not start. Fail-closed.
- **What this defends.**
  - A student opens `ServerSocket(7777)` on `fly-local-6pn` → packets dropped by INPUT rule. No other workspace can reach it.
  - A student opens an outbound TCP to `<other-machine>.vm.<workspace-app>.internal:8787` → packets dropped by OUTPUT rule. Can't even probe other workspaces' sidecars.
  - A student opens an outbound TCP to the control plane → ACCEPTED, but the control plane requires authenticated session cookies; student has no path to elevate.
- **What this does *not* defend.** Public-internet egress is open (students need to download Gradle dependencies). A student could exfiltrate data over the internet or attack public services. Out of scope for v1; document.
- **Tests** `containers/code/firewall.test.ts` (driven by a Docker container test that mimics the 6PN layout with a dummy interface):
  - Sidecar port reachable on the dummy 6PN address.
  - Other ports unreachable.
  - Outbound to a peer 6PN address drops.
  - Outbound to the control plane address ACCEPTs.
  - Outbound to a public IP ACCEPTs.
  - **DNS resolution against `fdaa::3` succeeds** (`getent hosts repo.maven.apache.org` returns a result) — proves the ruleset doesn't break workspace networking.
  - **Live Fly smoke check (manual step 7):** `./gradlew build` against a real WPILib template completes inside the workspace machine, confirming end-to-end that DNS + public-internet egress work under the firewall.
  - **`capsh --print` inside an exec spawned through the sidecar** shows no `cap_net_admin` in bounding, effective, permitted, inheritable, or ambient sets.
  - **`nft flush ruleset` attempted via the sidecar's exec endpoint** (i.e. through the path student code actually uses) fails with `Operation not permitted` — not "permission denied as wrong user", but specifically a capability-denial.
  - **`nft flush ruleset` attempted via an openvscode terminal session** (the other user-controlled path) also fails the same way.
- **Plus** the cross-tenant e2e test in W4 (workspace A → student-opened socket on workspace B → unreachable) validates this end-to-end in a real Fly smoke test.

## Sequencing

1. **W1** — interface cleanup, no behavior change. Ship green against existing tests.
2. **W5** — additive migration (including `current_image_revision`, `target_image_revision`, `rollout_state`, etc. columns for W12), no callers yet.
3. **W11** — `WorkspaceFileStore` abstraction with namespaced layout and `LocalFileStore` only. Wire all call sites to use it; conformance tests drive admin/asset/import/run routes. Docker mode behaves identically; this is a pure refactor that unblocks Fly without depending on it.
4. **W2** — factory + config (selects both runtime provider and file store together), defaults to Docker.
5. **W3** — Fly API client, including the machine-update endpoint W12 needs and `listMachines` filtered by metadata (W4 step 4 needs this).
6. **W13** — firewall init script in the workspace image. Verify with a Docker-based test using a dummy 6PN-like interface. Independent of the sidecar; can ship before W7. Blocks W4 because Fly machines should never come up without the firewall in place.
7. **W7** — sidecar + image change with reverse-proxy + namespaced file-store + exec endpoints + header-only auth on WS upgrades. Verify locally by running the image with `SIDECAR_BIND_HOST=127.0.0.1` and exercising every endpoint with the secret. Riskiest piece because of s6 wiring + reverse-proxy WS handling — green before W4 depends on it.
8. **W4** — Fly provider with state cache, import-before-create provisioning, self-healing `ensureWorkspaceRunning`, quarantine reconciliation, header-auth WS to sidecar, behind `FRC_RUNTIME_PROVIDER=fly`. Default users unaffected. `FlyFileStore` lands here so the factory can return the pair.
9. **W6** — lifecycle hooks wired into auth/admin flows. Provision is background + on-demand fallback in `ensureWorkspaceRunning`; never blocks login.
10. **W12** — fleet rollout CLI + state-machine provider method + reconcile CLI. Requires W4 + W5 + W3 in place.
11. **W8** + **W9** — Terraform + CI + Dockerfiles. Requires real Fly account access.
12. **W10** — docs alongside W4, W8, W12, W13.

## Risks & sharp edges

- **Cross-tenant isolation rests on two layers: sidecar auth (W7) + in-guest firewall (W13).** Either layer alone is insufficient. Sidecar-only is bypassable by student code binding raw sockets; firewall-only with no auth means any control-plane bug exposes editor RCE. Both must be tested independently and together. The "no editor/NT4/HALSim port and no `?token=` ever in a returned URL" invariant is a cheap grep-able regression guard — encode it as a contract test in W4.
- **`CAP_NET_ADMIN` blast radius.** W13's firewall needs `CAP_NET_ADMIN` to install nftables rules. The init script must drop the capability before any user-controlled process runs, including the sidecar's exec spawns. If that drop is missing, a student can `nft flush ruleset` and undo isolation. Audit the s6 longrun startup order; test that `capsh --print` inside a student exec shows no `cap_net_admin`.
- **DB rollback vs newer Fly resources.** Restoring the control plane's volume from an older snapshot can leave Fly machines/volumes with no DB row. **Recovery path is import-by-tag, not silent re-create.** W4 step 4 searches `listMachines` by `frc-workspace-id` before any fresh creation; live matches are auto-imported, quarantined matches fail closed and require operator action via `bun run fly:reconcile --import`. The `sidecar_secret` is recoverable from machine env via `getMachine` during import.
- **Provisioning crash between Fly create and DB write.** Resources are tagged with `frc-workspace-id` (and `frc-creation-intent`) *before* the create returns, so a crash after Fly succeeds but before the DB commit is recoverable: the next `provisionWorkspace` call's step (4) finds the resources by tag and re-imports.
- **`WorkspaceFileStore` migration scope.** W11 touches every site that today uses the local filesystem under the workspace dir. Audit checklist before W11 lands: `storage.ts`, `imports.ts`, `app/assets.ts`, `runs.ts`, `app/admin-routes.ts`, `scripts/backup.ts`, `scripts/restore.ts`. The conformance suite runs through actual routes (not just direct interface calls) — a route still reaching into `fs` directly fails the test.
- **Default backup still includes workspaces.** W11 keeps `bun run backup` including student data by default; opt out with `--skip-workspaces`. Under Fly that means streaming each student's namespaced subtrees through the sidecar; document the per-100-student wall-time estimate in the runbook and recommend Fly snapshots as primary for steady-state durability. Decision 025 captures snapshot retention/restore-drill minimums.
- **Status-poll read budget.** Frontend polls every 1s/5s. The 15s in-memory state cache (W4) is the only thing keeping Fly's 5 rps read budget non-explosive. If the cache TTL is too tight or invalidation is too aggressive, classroom use will exhaust the budget. Add a `fly_api_calls_total{endpoint}` metric.
- **Rollout is operator-driven, not automatic.** New workspace image deploys don't roll out to existing machines until someone runs `bun run fly:rollout`. That's the right default (avoids surprise restarts mid-class). A `stale_image_revision_workspaces_total` metric drives a warning if any machine lags by >N days.
- **Rollout never auto-rolls-back.** W12 intentionally leaves the `rollout_in_progress` lock held with a populated `last_rollout_error` after a failure in the start or health phase. The operator decides whether to `--resume` (retry forward via the observed-state path) or `--recreate` (destructive, machine ID changes). Silent rollback would hide the failure that needs human attention.
- **Exec/files routed through sidecar means a sidecar outage = no exec, no file ops.** The sidecar is now a SPOF inside a workspace. Its s6 service runs independently of openvscode and restarts on failure; W4 health-probes the sidecar after start and surfaces "sidecar unhealthy" as a distinct failure mode from "machine stopped".
- **`containers` field reach.** Many tests under `apps/control/src/__tests__/` call `app.containers.ensureCodeContainer(...)` and similar. Keeping `containers` as an optional Docker-only accessor (W1) avoids a sprawling test refactor — only Fly-mode tests need to avoid it.
- **Idle-sweep query** today is Docker-only — W5 fixes this. Easy to miss because Docker-mode tests pass either way.
- **Rate limits at class scale.** 1 rps creates are fine because we pre-create at sign-up, but a flood of OAuth sign-ups (a teacher pushing 30 students at once) would queue ~30s in the rate limiter. Surface this latency in the sign-up flow; don't block login on it.
- **Volume region pinning.** If the host that holds a student's volume is unavailable, `start` fails. Document manual recovery (recreate volume in different region, restore snapshot) — don't auto-migrate.
- **Stopped-machine billing.** Pre-creation means every workspace ever signed up costs something while stopped. Decide whether deletion is user-initiated only, or whether we sweep workspaces inactive for N days. Capture in decision 025.
- **Public-internet egress is allowed.** Students need Gradle/Maven downloads. W13's firewall only constrains 6PN. A student can exfiltrate over the internet or attack public services. Out of scope for v1; document in the threat model.
- **6PN constrains where the control plane runs.** Sidecar bearer over 6PN assumes the control plane is on Fly in the same org. Running the control plane elsewhere against Fly workspaces would need a public-but-mTLS sidecar — flag as out-of-scope for v1 in decision 025.
- **DockerStatsPoller assumed unconditionally at startup.** Behind a `containers != null` guard after W1, replaced by a `FlyStatsPoller` (with degraded per-workspace stats) in Fly mode.

## Verification

**Unit tests** (`bun test`):
- `apps/control/src/fly/client.test.ts` — request shape, 429 retry, 404, rate-limiter queueing, machine-update endpoint, `listMachines` filtered by metadata.
- `apps/control/src/fly/fly-runtime-provider.test.ts` — `FakeFlyApiClient`. Cases: provision idempotency (all four steps); **DB-rollback race** (Fly machine tagged with workspaceId but no DB row → re-imports, never double-creates); **quarantined-resource block** (`QuarantinedResourceError` raised); **DB-write-failure race** (Fly create succeeds + DB write throws → next call re-imports by tag); self-healing `ensureWorkspaceRunning` (no row / missing machine / missing volume must throw `OrphanedVolumeError`); state cache hit/miss/invalidate; single-flight dedup under 50 concurrent callers; cross-tenant 401 (workspace A URL + workspace B secret); endpoint URLs never contain editor/NT4/HALSim ports and never contain `?token=`; log-redaction guard (capture proxy logs, assert no bearer or 32+-char hex appears); reconciliation quarantines (including DB-rollback) — never deletes; 60s exec succeeds (no 30s clamp).
- `apps/control/src/fly/fly-rollout.test.ts` — see W12's detailed test list (no-op, six-phase happy path, failure-at-each-phase with documented lock state, crash-at-every-boundary observed-state resume, mutable-tag-cannot-advance-revision, digest-changed-under-same-tag, post-write `skip_launch` invariant, full-config preservation + repair_required on mismatch, atomic-lock contention, resume token rotation, partial-fleet failure isolation, `--recreate` confirmation flag).
- `apps/control/src/runtime-factory.test.ts` — selection by env, validation failures, pairs runtime provider with matching file store.
- `apps/control/src/__tests__/workspace-file-store.test.ts` — shared conformance suite over `LocalFileStore` and `FlyFileStore` (in-memory sidecar): read/write/list/archive/extract (both `replace` and `merge` modes) / seedTemplate / diskUsage across all four namespaces (`project`, `assets`, `logs`, `backups`); path-traversal rejection; **interrupted-restore preserves prior tree** (asserted against both implementations); **malformed tar rejection**. **Route-level driver:** the same conformance suite is also driven through actual admin/asset/import/run routes to catch missed call sites — a test failure means a route is still reaching into `fs` directly.
- `apps/control/src/__tests__/backup-restore-fly.test.ts` — backup driver against a fake Fly provider where some workspace machines are stopped and one machine fails health check: confirms previously-stopped machines are started/streamed/stopped; previously-started machines are streamed without state change; failed machines are recorded in the manifest with `status:"failed"` and don't abort the run; concurrency bound is respected.
- `containers/code/sidecar/sidecar.test.ts` — exec sync + stream + kill; auth rejection on missing/wrong bearer on every endpoint including WS upgrade; **explicit 400 rejection on any URL containing `?token=`**; reverse-proxy preserves WS upgrade and body framing; file-store namespace + path-traversal rejection; **`mode=replace` interrupted mid-extract leaves the original tree intact** (kill the connection mid-transfer, confirm `<path>` is unchanged and `<path>.incoming.<uuid>` is cleaned up); **crash-between-renames recovery** (write a journal in `pending` state, simulate process exit, restart the sidecar, assert reconciliation correctly resolves to either old or new tree based on journal state); **`renameat2(RENAME_EXCHANGE)` happy path** (assert atomicity by holding a reader on the canonical path across the swap); **malformed tar with `..` or symlink/hardlink escape is rejected before any write**; **per-member and per-archive size caps enforced**; concurrent exec channel isolation.
- `containers/code/firewall.test.ts` (Docker-driven with a dummy IPv6 interface) — sidecar port reachable; other ports unreachable; outbound to peer 6PN address drops; outbound to designated control plane address ACCEPTs; outbound to public IP ACCEPTs; `nft` invocation by a non-root user fails to modify the ruleset.
- **Contract test:** assert no `WorkspaceRuntime.endpoints` URL returned by `FlyMachinesRuntimeProvider` ever references ports 3000, 5810, or 3300, or contains a `?token=` substring. Cheap, catches the most dangerous accidental regression.

**Integration** — existing E2E (Playwright, fake fixtures) does not use real Docker; add a Fly-shaped fake provider + fake sidecar to the e2e fixture set so the proxy is exercised against `*.vm.*.internal:8787/{vscode,nt4,halsim}/...` URLs with header-only bearer auth. Cover: immediate-post-OAuth editor access (the self-healing path), idle stop, run-with-streaming-output, rollout state-machine across a CP restart. Don't bring real Fly into E2E.

**Manual smoke against a real Fly app:**
1. `flyctl apps create coderunner-control-test` and `coderunner-workspace-test`.
2. `terraform apply` in `deploy/terraform-fly/` (test workspace).
3. `flyctl deploy` both apps.
4. Open control plane URL, log in via OAuth → confirm workspace row + Fly machine appear; **immediately** click into the editor before background provision finishes to exercise the self-healing path.
5. Open the editor → ≤2s start, openvscode loads, project files present (template seeded).
6. Hit Run → streaming logs in the browser, sim NT4 visible in AdvantageScope.
7. Trigger an import of a 50MB-ish repo → completes without 30s timeout error.
8. **Cross-tenant attack test.** From a second workspace machine (via `flyctl ssh console`), bind a `python3 -m http.server 7777` on `fly-local-6pn` from workspace A; confirm from workspace B that connecting to A's 7777 times out (W13 firewall). Confirm `curl http://<other-machine>.vm.coderunner-workspace-test.internal:8787/healthz -H 'Authorization: Bearer <wrong>'` returns 401 (sidecar auth) when the firewall is temporarily relaxed for the test — and is unreachable when the firewall is in place.
9. **Log-redaction check.** Grep the control plane logs from the test session for any 32+-char hex string in a URL or any literal `Bearer ` token — should find none.
10. **DB-rollback recovery.** Restore the control plane volume from an earlier snapshot (simulating DB rollback) → newer workspaces' machines get quarantined, never deleted; `bun run fly:reconcile --import <workspaceId>` re-binds them and the student's files are intact.
11. **Rollout state-machine.** Bump `FRC_FLY_WORKSPACE_IMAGE_REVISION`, `flyctl deploy` the workspace image, `bun run fly:rollout --dry-run` shows pending. Inject a fault that fails the start phase → confirm `rollout_in_progress=true` with `last_rollout_error` populated, run `--resume`, machine starts on the new image with the same volume + project contents.
12. Idle past threshold → `flyctl machines status` shows the machine stopped.
13. Delete the workspace via admin UI → machine and volume both gone (this is the only deletion path; reconciliation alone never deletes).
14. Kill the control plane machine mid-run → restart → `reconcileOrphanedRuns` cleans up, the workspace machine is still sane, the sidecar reports healthy.
