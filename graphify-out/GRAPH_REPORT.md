# Graph Report - FRC-Programming-Training-Sim  (2026-05-09)

## Corpus Check
- 116 files · ~84,288 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1542 nodes · 2183 edges · 119 communities (108 shown, 11 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4e623c4a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]
- [[_COMMUNITY_Community 92|Community 92]]
- [[_COMMUNITY_Community 93|Community 93]]
- [[_COMMUNITY_Community 94|Community 94]]
- [[_COMMUNITY_Community 95|Community 95]]
- [[_COMMUNITY_Community 118|Community 118]]

## God Nodes (most connected - your core abstractions)
1. `ContainerOrchestrator` - 52 edges
2. `AppStorage` - 36 edges
3. `FRC Web Simulator V1: Design Document` - 24 edges
4. `RunManager` - 21 edges
5. `FRC Web Simulator V2: Design Document` - 20 edges
6. `isObject()` - 13 edges
7. `nowIso()` - 13 edges
8. `Test Plan` - 13 edges
9. `FRC Web Simulator V1 — Operator Runbook` - 13 edges
10. `resolveProjectFilePath()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `readProjectTreeNode()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps/control/src/app.ts → packages/contracts/src/index.ts
- `resolveProjectFilePath()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps/control/src/app.ts → packages/contracts/src/index.ts
- `workspaceSlugFromLocation()` --calls--> `isWorkspaceSlug()`  [INFERRED]
  apps/web/src/main.tsx → packages/contracts/src/index.ts
- `App()` --calls--> `isWorkspaceSlug()`  [INFERRED]
  apps/web/src/main.tsx → packages/contracts/src/index.ts
- `registerSemanticTokens()` --calls--> `semanticTokensProvider()`  [EXTRACTED]
  apps/web/src/java-lsp.ts → mvp/apps/web/src/java-lsp.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (119 total, 11 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (33): codeContainerName(), CodeContainerStatus, containerName(), ContainerOrchestrator, ContainerOrchestratorOptions, containerRuntimeState(), defaultDockerRunner(), DockerCommandResult (+25 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (38): ControlConfig, ControlConfigInput, defaultContainerUser(), defaultDataDir, defaultLspPortRange, defaultSimPortRange, defaultVscodePortRange, loadControlConfig() (+30 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (57): aliceConnection, aliceCookie, aliceMessages, aliceRun, aliceRunId, aliceWorkspace, authHeaders, backedUpProject (+49 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (46): BrowserLspClient, completionItems(), completionItemsToSuggestions(), documentationToMarkdown(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), initializeParams() (+38 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (47): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 001: Sim Container Architecture, Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process (+39 more)

### Community 5 - "Community 5"
Cohesion: 0.04
Nodes (46): AdminActionResponse, adminActionResponseSchema, AdminStatusResponse, adminStatusResponseSchema, AdminWorkspaceStatus, adminWorkspaceStatusSchema, ContainerRole, ContainersStatusResponse (+38 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (40): advantageScopeUrl(), appendConsole(), consoleEl, currentSessionUser(), editor, editorEl, envValue(), flushSave() (+32 more)

### Community 7 - "Community 7"
Cohesion: 0.1
Nodes (27): acceptWebSocket(), ActiveRun, activeRuns, collectProcess(), delay(), docker(), dockerExec(), handleRun() (+19 more)

### Community 8 - "Community 8"
Cohesion: 0.08
Nodes (31): ascopeRoot, assert(), createTemplate(), distDir, exists(), patchDir, repoRoot, runGit() (+23 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (23): AppSocket, AssetManifest, BunUpgradeServer, ControlAppOptions, createProjectArchive(), HOP_BY_HOP_HEADERS, isReservedProjectTempName(), LspSocketData (+15 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (14): consumeLines(), defaultRunCommandFactory(), dockerRunScript(), lineLooksReady(), randomRunId(), RunCommand, RunCommandContext, RunCommandFactory (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (24): assert(), assertNt4AliveProbe(), assertSimProcessAlive(), buildingTimes, initializeLspSession(), latest, Login, logins (+16 more)

### Community 12 - "Community 12"
Cohesion: 0.08
Nodes (19): isWorkspaceSlug(), JavaLspController, App(), canOpen(), EditorStatus, fetchJson(), fileName(), languageFor() (+11 more)

### Community 13 - "Community 13"
Cohesion: 0.12
Nodes (24): aliceRun, assert(), assertNt4AliveProbe(), assertSimProcessAlive(), bobRun, brokenAlice, fileUri(), initializeLspSession() (+16 more)

### Community 14 - "Community 14"
Cohesion: 0.07
Nodes (28): 1. Find your host IP, 2. Start the control plane, 3. Connect from other machines, 4. Firewall (if needed), code:bash (# Linux), code:bash (cd /path/to/FRC-Programming-Training-Sim), code:block3 (─── V1 Configuration ───), code:block4 (http://<host-ip>:4000) (+20 more)

### Community 15 - "Community 15"
Cohesion: 0.17
Nodes (25): applyAdvantageScopePatches(), ascopeRoot, CommandResult, patchDir, patchFiles(), repoRoot, run(), ascopeLiteStatic (+17 more)

### Community 16 - "Community 16"
Cohesion: 0.1
Nodes (20): code:text (vendor/AdvantageScope d2e915f580ca4ad9444a5211bf89fe71b128de), code:block10 (apps/web/              Vite browser shell with Monaco, AS Li), code:bash (git clone https://github.com/emscripten-core/emsdk.git), code:bash (export EMSDK=/path/to/emsdk    # bash), code:bash (git clone <this-repo>), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker exec frc-sim-mvp cat /workspace/project/src/main/java) (+12 more)

### Community 17 - "Community 17"
Cohesion: 0.1
Nodes (20): 002 — AdvantageScope Lite hosted standalone, 1. `spawnSync(npmCmd, [...], { shell: false })` returns exit `null` on Windows, 2. AS Lite ships a `lite/static/` directory inside the submodule with `index.html` and `popups.css`, 3. Git symlinks under `lite/static/` checked out as 9-byte text files on Windows, 4. AS Lite expects `GET /assets` and `GET /assets/<name>/<file>` server routes, 5. AS submodule's `postinstall` is heavy, 6. AS upstream prints `npm audit` warnings about transitive vulns, AdvantageScope as a git submodule pinned to a release tag (+12 more)

### Community 18 - "Community 18"
Cohesion: 0.1
Nodes (19): 001 — Sim container architecture, 1. Missing `WPILibNewCommands.json` vendor dep, 2. Dockerfile `|| true` swallowed gradle build failure, 3. Image size came in at 2.25 GB, not the 1.0–1.4 GB plan estimate, 4. Wrapper-zip warning is cosmetic, Context, Decisions, `eclipse-temurin:17-jdk-jammy` base image (+11 more)

### Community 19 - "Community 19"
Cohesion: 0.12
Nodes (13): CreateServerOptions, decoder, encoder, findLauncherJar(), firstConnectionWarmupMs, jdtLsArgs(), jdtLsLauncher(), LspSocketData (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.11
Nodes (17): Auto-import on Tab (additionalTextEdits), code:dockerfile (FROM gitpod/openvscode-server:1.105.1), code:bash (cd /tmp/frc-spike-openvscode), Container boots and serves (:3000), Ctrl-click into library source (jdt:// URI), Decision 011: V2 Editor Spike — openvscode-server with redhat.java and WPILib, Decisions, Docker Hub vs GitHub Releases (+9 more)

### Community 21 - "Community 21"
Cohesion: 0.11
Nodes (17): 003 — Minimal web shell, 1. Headless preview screenshot hangs when AS Lite iframe is loading, 2. Orphaned Vite child after `TaskStop` on the npm wrapper, 3. `WARNING:StorageManager: settings timeout, using defaults` in the console, 4. AS Lite tab-controls panel was clipped (initial layout), AS Lite via iframe to `http://localhost:8080`, not bundled, code:block1 ("editor       scope"), Context (+9 more)

### Community 22 - "Community 22"
Cohesion: 0.11
Nodes (17): 006 - Multi-tenancy spike findings, code:text (alice alive 200 ok), code:bash (npm run spike:multi -- up), code:text (alice: websocket open=true, initialized=true, diagnostics=0), code:text (open=true, initialized=true), code:text (GET /file?user=alice -> 200), code:text (status building at 1 ms), code:text (sim container created in 0.29s) (+9 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (16): 0. Decisions at a Glance, 13. Java LSP, 15. Failure Modes, 16. Security Posture for V1, 17. Verification Strategy, 19. V1 Definition of Done, 1. Context, 20. Open Questions (+8 more)

### Community 24 - "Community 24"
Cohesion: 0.12
Nodes (17): 15. Staged Implementation Plan, code:block20 (docker build -t frc-spike-openvscode .), code:block21 (bun run docker:build:code), code:block22 (# Build and start a Stage 1 container manually.), code:block23 (bun run typecheck), code:block24 (bun run build:web), code:block25 (bun run typecheck), code:block26 (# Idle teardown:) (+9 more)

### Community 25 - "Community 25"
Cohesion: 0.12
Nodes (17): 2.1 Clone and initialize, 2.2 Build container images, 2.3 Build web assets, 2.4 Configure environment, 2.5 Run migrations, 2.6 Verify the setup, 2.7 Measure host resources, 2. Initial Setup (+9 more)

### Community 26 - "Community 26"
Cohesion: 0.12
Nodes (16): Bind mounts, Build, code:bash (bun run docker:build:code), code:bash (FRC_UID=$(id -u) FRC_GID=$(id -g) bun run docker:build:code), code:block3 (frc-sim.managed=true), code:bash (docker run -d \), Environment variables, Example run (+8 more)

### Community 27 - "Community 27"
Cohesion: 0.33
Nodes (14): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.12
Nodes (16): 9.1 Router, 9.2 Session manager, 9.3 Project store, 9.4 Container orchestrator, 9.5 Run service, 9.6 NT4 proxy, 9.7 LSP proxy, 9.8 Operator endpoints (+8 more)

### Community 29 - "Community 29"
Cohesion: 0.12
Nodes (16): 9. Common Failures and Recovery, AS Lite not showing telemetry, Build queue saturated, code:bash (# Container is auto-recreated on next run. If persistent:), code:bash (# Restart LSP container), code:bash (# 1. Prune run logs (safest, usually largest)), code:bash (bun run dev:control), code:bash (bun run migrate:status  # verify DB is accessible) (+8 more)

### Community 30 - "Community 30"
Cohesion: 0.12
Nodes (15): Architecture (MVP), code:block1 (+----------------------------------+), Explicitly deferred to post-MVP, FRC Web Simulator: Project Summary and MVP Spec, MVP scope, Note to the implementing agent, Overall MVP definition of done, Project summary (+7 more)

### Community 31 - "Community 31"
Cohesion: 0.12
Nodes (14): Build, code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker run --rm -p 5810:5810 --memory=2g --name frc-sim frc-), code:block3 (NT: server: listening on NT4 port 5810), code:bash (docker stop frc-sim), Hacking, Run, Runtime Contract (+6 more)

### Community 32 - "Community 32"
Cohesion: 0.28
Nodes (15): apiError(), assertRealPathInside(), createProjectEntry(), deleteProjectEntry(), fsErrorCode(), isInsideDirectory(), isMissingPathError(), isNonEmptyDirectoryError() (+7 more)

### Community 33 - "Community 33"
Cohesion: 0.14
Nodes (13): 0. Decisions at a Glance, 11. Resource Budget, 12. Failure Modes, 13. Security Posture, 14. Verification, 17. Open Questions, 18. Rules for Agents, 1. Context (+5 more)

### Community 34 - "Community 34"
Cohesion: 0.14
Nodes (13): Context, Definition of done, Experiments, Goals, Key questions, Multi-Tenancy Spike, Non-goals, Q1: NT4 routing under multi-tenancy (+5 more)

### Community 35 - "Community 35"
Cohesion: 0.15
Nodes (12): 009 - LSP reconnect, bridge serialization, and startup throttling, Context, Decision 1: Browser LSP client auto-reconnects with bounded backoff, Decision 2: Bridge serializes JDT LS spawns, Decision 3: Orchestrator-level LSP startup throttle, Decision 4: Cap proxy pending-message buffers, Decision 5: NT4 subprotocol mismatch is fail-fast, not silent, Decision 6: AS Lite in-iframe timeout banner (+4 more)

### Community 37 - "Community 37"
Cohesion: 0.29
Nodes (10): children, ensureContainer(), ensureLspContainer(), ensureSimContainer(), repoRoot, runCommand(), shutdown(), startProcess() (+2 more)

### Community 38 - "Community 38"
Cohesion: 0.17
Nodes (12): 18. Implementation Phases, V1-0: Archive MVP and scaffold V1 root, V1-10: V1 acceptance pass, V1-1: Contracts, storage, and session skeleton, V1-2: Control-plane routing and static shell, V1-3: Project store and multi-file editor, V1-4: V1 sim image and container orchestrator, V1-5: Run queue and log streaming (+4 more)

### Community 39 - "Community 39"
Cohesion: 0.17
Nodes (12): 8.1 Browser routes, 8.2 API routes, 8.3 WebSocket routes, 8.4 Run WebSocket messages, 8. Public Routing Contract, code:block13 (GET  /                         login or redirect to current ), code:block14 (/u/:workspaceSlug/api/...), code:block15 (GET    /session) (+4 more)

### Community 40 - "Community 40"
Cohesion: 0.17
Nodes (12): 7.1 Browser routes, 7.2 Editor proxy routes, 7.3 API routes, 7.4 Admin routes, 7.5 WebSocket routes, 7. Public Routing Contract, code:block10 (GET   /admin/status), code:block11 (WS /u/:workspaceSlug/ws/run           run queue, unchanged) (+4 more)

### Community 41 - "Community 41"
Cohesion: 0.17
Nodes (12): 7. Cache Cleanup, code:bash (bun run docker:cleanup), code:bash (bun run docker:cleanup -- --dry-run), code:bash (rm -rf data/users/<workspaceId>/home/), code:bash (rm -rf data/users/<workspaceId>/logs/runs/*), code:bash (for dir in data/users/*/; do), code:bash (docker system prune -f          # Remove unused containers, ), Docker system cleanup (+4 more)

### Community 42 - "Community 42"
Cohesion: 0.18
Nodes (9): app, AssetManifest, buildAssetManifest(), bundledAssetsDir, distDir, port, rel, repoRoot (+1 more)

### Community 43 - "Community 43"
Cohesion: 0.27
Nodes (10): ContainerStats, dockerRun(), getContainerStats(), getDiskInfo(), getHostInfo(), HostInfo, jsonOutput, main() (+2 more)

### Community 44 - "Community 44"
Cohesion: 0.18
Nodes (11): 7.1 IDs, 7.2 SQLite tables, 7.3 Filesystem layout, 7.4 Template provenance, 7. Domain Model, code:block10 (data/users/<workspaceId>/project  ->  /workspace/project), code:block11 (data/users/<workspaceId>/jdtls-data  ->  /workspace/jdtls-da), code:block12 (data/users/<workspaceId>/home  ->  /home/frc) (+3 more)

### Community 45 - "Community 45"
Cohesion: 0.18
Nodes (10): 1. Prerequisites, 3. Starting the App, code:bash (bun run dev:control), code:bash (curl http://localhost:4000/admin/status), FRC Web Simulator V1 — Operator Runbook, One-command start, Quick Reference Card, Table of Contents (+2 more)

### Community 46 - "Community 46"
Cohesion: 0.18
Nodes (10): Base image: `gitpod/openvscode-server:1.105.1`, Consequences, Context, Decision, Decision 012: V2 Code Image — Base Image and Extension Strategy, Direct launch base path handling, Extension cache seeding pattern, Extensions: download at build time (+2 more)

### Community 47 - "Community 47"
Cohesion: 0.2
Nodes (9): createFileRequestSchema, getProjectPathAccess(), isProjectPath(), matchesPathOrChild(), parseProjectPath(), runClientMessageSchema, runServerMessageSchema, invalidPaths (+1 more)

### Community 50 - "Community 50"
Cohesion: 0.31
Nodes (9): code:powershell (git submodule update --init --recursive), code:text (apps/control/                  Bun control plane with login,), Commands, FRC Web Simulator, FRC Web Simulator V1, Layout, Operator Runbook, Prerequisites (+1 more)

### Community 51 - "Community 51"
Cohesion: 0.2
Nodes (10): 8.1 Merged code image, 8.2 Memory and concurrency, 8.3 UID/GID and bind mounts, 8.4 Port allocation, 8. Container Design, code:block12 (FROM eclipse-temurin:17-jdk-jammy), code:block13 (openvscode-server --install-extension /opt/extensions/redhat), code:block14 (#!/usr/bin/env bash) (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.2
Nodes (10): 6. Backup and Restore, code:bash (bun run backup), code:bash (bun run backup -- --output /path/to/backup), code:bash (bun run restore -- <backup-dir>), code:bash (bun run restore -- <backup-dir> --dry-run), code:bash (bun run restore -- <backup-dir> --workspace ws_abc123...), Create a backup, Recommended backup schedule (+2 more)

### Community 53 - "Community 53"
Cohesion: 0.2
Nodes (9): 007 - V1 sim container orchestration, code:text (frc-sim.managed=true), Context, Decisions, Docker labels are adopted back into SQLite, Lazy ensure, visible status, Loopback-only published ports, Runtime cache seed (+1 more)

### Community 54 - "Community 54"
Cohesion: 0.2
Nodes (9): 008 - V1 LSP container and Bun-native bridge, Browser LSP client extended for multi-file projects, Bun-native bridge instead of `vscode-ws-jsonrpc`, code:block1 (data/users/<workspaceId>/project    -> /workspace/project), `container_leases` lease state split, Context, Decisions, Generic `ContainerOrchestrator` (+1 more)

### Community 55 - "Community 55"
Cohesion: 0.2
Nodes (9): 004 - Backend wiring for save and run, Context, Custom WebSocket sender, no new dependency, Decisions, Host backend plus Docker CLI, Minimal endpoints and run protocol, One-command dev stack without Docker Compose, Replaceable sim process inside long-lived container (+1 more)

### Community 56 - "Community 56"
Cohesion: 0.22
Nodes (9): 8. Monitoring, Admin status API, code:bash (curl http://localhost:4000/admin/status | jq .), code:bash (bun run measure), code:bash (bun run measure -- --json), code:bash (# All managed containers), Docker container status, Resource measurement (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.22
Nodes (9): 10. Host Sizing, code:bash (bun run measure), code:block39 (═══ FRC Web Simulator — Resource Report ═══), code:bash (SIM_MEMORY_LIMIT=1024m), code:bash (SIM_MEMORY_LIMIT=2048m), Measuring actual usage, Per-student resource usage, Sizing recommendations (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.29
Nodes (6): children, repoRoot, shutdown(), startProcess(), tsxCli, viteCli

### Community 59 - "Community 59"
Cohesion: 0.46
Nodes (7): dirExists(), fileExists(), main(), parseArgs(), restoreArchive(), restoreDirectory(), runTar()

### Community 60 - "Community 60"
Cohesion: 0.25
Nodes (8): 11.1 Patch strategy, 11.2 Build pipeline, 11.3 Sub-path hosting contract, 11. AdvantageScope Lite, code:block29 (patches/advantagescope/001-lite-nt4-endpoint-injection.patch), code:ts (type ScopeConfigMessage = {), code:ts (type ScopeReadyMessage = {), code:block32 (bun run build:ascope)

### Community 61 - "Community 61"
Cohesion: 0.25
Nodes (8): 12.1 Product shape, 12.2 Editor model, 12.3 AS Lite iframe, 12.4 Status model, 12. Web Shell, code:block33 (file:///workspace/project/<project-relative-path>), code:block34 (/scope/?frcEndpoint=postMessage), code:block35 (aliveUrl:     /u/<workspaceSlug>/sim/alive)

### Community 62 - "Community 62"
Cohesion: 0.25
Nodes (8): 6.1 IDs, 6.2 SQLite changes, 6.3 Filesystem layout, 6. Domain Model Changes, code:block2 (frc-v2-code-<workspaceId>), code:block3 (frc-sim.managed=true), code:block4 (-- 004_v2_code_container.sql), code:block5 (data/)

### Community 63 - "Community 63"
Cohesion: 0.25
Nodes (8): 10.1 Layout, 10.2 Run/Stop, 10.3 AS Lite iframe, 10.4 Heartbeat, 10.5 Removal, 10. Web Shell (V2), code:block17 (docker exec <containerName> bash -lc "/usr/local/bin/stop-si), code:ts ({)

### Community 64 - "Community 64"
Cohesion: 0.25
Nodes (7): 005 - Java LSP MVP integration, Context, Decisions, Local WPILib-aware JDT LS image, Package and Vite choices, Plain Monaco client with direct LSP requests, Verification

### Community 65 - "Community 65"
Cohesion: 0.29
Nodes (7): 6.1 Bun, 6.2 Backend framework, 6.3 Frontend framework, 6.4 Validation and shared contracts, 6. Tooling Decisions, code:block5 (.bun-version), code:json ({)

### Community 66 - "Community 66"
Cohesion: 0.29
Nodes (7): 16. Manual End-to-End Test Plan, code:block28 (git clone <repo-url> FRC-Programming-Training-Sim), code:block29 (bun run docker:build:code), code:block30 (bun run migrate), code:block31 (# In another shell:), code:block32 (curl -fsS -X POST http://localhost:4000/admin/workspaces/<al), code:block33 (curl -fsS -X POST http://localhost:4000/admin/workspaces/<al)

### Community 67 - "Community 67"
Cohesion: 0.29
Nodes (7): 4. Stopping the App, Between class sessions, code:bash (bun run docker:cleanup), code:bash (# Stop all workspaces), code:bash (docker stop $(docker ps -q --filter label=frc-sim.managed=tr), Graceful stop, Stop containers too

### Community 68 - "Community 68"
Cohesion: 0.29
Nodes (3): Intentional Template Contents, Provenance, WPILib Java Command Starter Template

### Community 70 - "Community 70"
Cohesion: 0.29
Nodes (7): apiErrorResponse(), authFromRequest(), jsonResponse(), readScopeAssetManifest(), redirect(), resolveWorkspaceRequest(), scopeResponse()

### Community 71 - "Community 71"
Cohesion: 0.48
Nodes (6): base64Url(), parseCookies(), parseSignedSessionCookie(), serializeExpiredSessionCookie(), serializeSessionCookie(), signSessionId()

### Community 72 - "Community 72"
Cohesion: 0.6
Nodes (5): dirExists(), main(), parseArgs(), runTar(), timestamp()

### Community 73 - "Community 73"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 74 - "Community 74"
Cohesion: 0.33
Nodes (6): 5.1 Archive the MVP first, 5.2 V1 target layout, 5. Repository Migration and Layout, code:block2 (mvp/), code:block3 (V1-Design.md), code:block4 (apps/)

### Community 75 - "Community 75"
Cohesion: 0.33
Nodes (6): 5. Configuration, code:bash (SIM_MEMORY_LIMIT=1024m), code:bash (SIM_MEMORY_LIMIT=1536m), Key settings for classroom use, Tuning for constrained hosts, Tuning for large classrooms

### Community 76 - "Community 76"
Cohesion: 0.33
Nodes (6): nt4WebSocketResponse(), probeVscodeReady(), requestedProtocols(), stripHopByHopHeaders(), vscodeHttpProxyResponse(), vscodeWebSocketResponse()

### Community 77 - "Community 77"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 78 - "Community 78"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 79 - "Community 79"
Cohesion: 0.4
Nodes (4): hubBundle, replacements, repoRoot, source

### Community 80 - "Community 80"
Cohesion: 0.5
Nodes (4): dryRun, main(), repoRoot, run()

### Community 81 - "Community 81"
Cohesion: 0.4
Nodes (5): 10.1 Sim image, 10.2 LSP image, 10. Container Design, code:block27 (docker run -d), code:block28 (docker run -d)

### Community 82 - "Community 82"
Cohesion: 0.4
Nodes (5): 4.1 Channels, 4.2 What lives inside the merged container, 4.3 What no longer exists, 4. Target Architecture, code:block1 (Browser)

### Community 83 - "Community 83"
Cohesion: 0.4
Nodes (5): 9.1 HTTP proxy, 9.2 WebSocket proxy, 9.3 Tokenless mode, 9.4 Health probe, 9. Editor Proxy

### Community 84 - "Community 84"
Cohesion: 0.4
Nodes (4): 010 - Gradle project cache isolation for sim and LSP, Context, Decisions, Implications

### Community 85 - "Community 85"
Cohesion: 0.5
Nodes (5): escapeHtml(), htmlResponse(), loginPage(), webShellResponse(), workspacePage()

### Community 86 - "Community 86"
Cohesion: 0.4
Nodes (5): contentTypeFor(), notFound(), safeRelativeAssetPath(), staticFileResponse(), webAssetResponse()

### Community 88 - "Community 88"
Cohesion: 0.5
Nodes (4): createAdvantageScopeDist(), createTemplate(), createWebDist(), withApp()

### Community 89 - "Community 89"
Cohesion: 0.5
Nodes (4): 14.1 Initial sizing, 14.2 Lifecycle timeline, 14. Resource Budget and Lifecycle, code:block36 (SIM_MEMORY_LIMIT=1536m)

### Community 90 - "Community 90"
Cohesion: 0.5
Nodes (3): Intentional Template Contents, Provenance, WPILib Java Command Starter Template

## Knowledge Gaps
- **652 isolated node(s):** `workspaceSlugSchema`, `userIdSchema`, `workspaceIdSchema`, `sessionIdSchema`, `displayNameSchema` (+647 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `port` connect `Community 8` to `Community 7`?**
  _High betweenness centrality (0.057) - this node is a cross-community bridge._
- **Why does `isWorkspaceSlug()` connect `Community 12` to `Community 5`, `Community 47`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `ContainerOrchestrator` connect `Community 0` to `Community 9`, `Community 10`, `Community 69`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `workspaceSlugSchema`, `userIdSchema`, `workspaceIdSchema` to the rest of the system?**
  _652 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._