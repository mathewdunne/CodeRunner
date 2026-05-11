# Graph Report - FRC-Programming-Training-Sim  (2026-05-11)

## Corpus Check
- 116 files · ~99,189 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2607 nodes · 3887 edges · 85 communities detected
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.82)
- Token cost: 0 input · 0 output

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
- [[_COMMUNITY_Community 131|Community 131]]

## God Nodes (most connected - your core abstractions)
1. `ContainerOrchestrator` - 59 edges
2. `cn()` - 58 edges
3. `AppStorage` - 44 edges
4. `FRC Web Simulator V1: Design Document` - 24 edges
5. `FRC Web Simulator V1: Design Document` - 24 edges
6. `RunManager` - 22 edges
7. `createApp()` - 21 edges
8. `Button()` - 20 edges
9. `FRC Web Simulator V2: Design Document` - 20 edges
10. `FRC Web Simulator V2: Design Document` - 20 edges

## Surprising Connections (you probably didn't know these)
- `createApp()` --calls--> `createStorage()`  [INFERRED]
  apps\control\src\app.ts → apps\control\src\storage.ts
- `verifyScopeServing()` --calls--> `createApp()`  [INFERRED]
  scripts\verify-ascope.ts → apps\control\src\app.ts
- `withApp()` --calls--> `createApp()`  [INFERRED]
  apps/control/src/app.test.ts → apps\control\src\app.ts
- `readProjectTreeNode()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps/control/src/app.ts → packages/contracts/src/index.ts
- `resolveProjectFilePath()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps/control/src/app.ts → packages/contracts/src/index.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (132 total, 9 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (130): AdminLayout(), Tab, tabs, ConsolePane(), ConsolePaneProps, EditorPane(), EditorPaneProps, IDELayout() (+122 more)

### Community 1 - "Community 1"
Cohesion: 0.03
Nodes (95): getSessionFromRequest(), isAllowedWebSocketOrigin(), isLoopbackHost(), normalizeHost(), requireAdmin(), requireSession(), requireWebSocketOrigin(), requireWorkspaceOwnership() (+87 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (110): ControlAppOptions, createApp(), DockerRunner, consumeLines(), defaultRunCommandFactory(), dockerRunScript(), lineLooksReady(), randomRunId() (+102 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (107): aliceRun, assert(), assertNt4AliveProbe(), assertSimProcessAlive(), bobRun, brokenAlice, fileUri(), initializeLspSession() (+99 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (105): 0. Decisions at a Glance, 10.1 Sim image, 10.2 LSP image, 10. Container Design, 11.1 Patch strategy, 11.2 Build pipeline, 11.3 Sub-path hosting contract, 11. AdvantageScope Lite (+97 more)

### Community 5 - "Community 5"
Cohesion: 0.02
Nodes (105): 0. Decisions at a Glance, 10.1 Sim image, 10.2 LSP image, 10. Container Design, 11.1 Patch strategy, 11.2 Build pipeline, 11.3 Sub-path hosting contract, 11. AdvantageScope Lite (+97 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (56): addAllowlistEntry(), AllowlistData, EMPTY, isEmailAllowed(), loadAllowlist(), normalize(), normalizeEntry(), reloadAllowlist() (+48 more)

### Community 7 - "Community 7"
Cohesion: 0.03
Nodes (102): 10. Host Sizing, 1. Prerequisites, 2.1 Clone and initialize, 2.2 Build container images, 2.2 Build the code container image, 2.3 Build web assets, 2.4 Configure environment, 2.5 Run migrations (+94 more)

### Community 8 - "Community 8"
Cohesion: 0.06
Nodes (35): codeContainerName(), CodeContainerStatus, containerName(), ContainerOrchestrator, ContainerOrchestratorOptions, containerRuntimeState(), defaultDockerRunner(), dockerError() (+27 more)

### Community 9 - "Community 9"
Cohesion: 0.02
Nodes (86): 0. Decisions at a Glance, 10.1 Layout, 10.2 Run/Stop, 10.3 AS Lite iframe, 10.4 Heartbeat, 10.5 Removal, 10. Web Shell (V2), 11. Resource Budget (+78 more)

### Community 10 - "Community 10"
Cohesion: 0.02
Nodes (85): 0. Decisions at a Glance, 10.1 Layout, 10.2 Run/Stop, 10.3 AS Lite iframe, 10.4 Heartbeat, 10.5 Removal, 10. Web Shell (V2), 11. Resource Budget (+77 more)

### Community 11 - "Community 11"
Cohesion: 0.03
Nodes (65): aliceConnection, aliceCookie, aliceMessages, aliceRun, aliceRunId, aliceWorkspace, authHeaders, backedUpProject (+57 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (45): acceptWebSocket(), ActiveRun, activeRuns, asWebSocket(), collectProcess(), delay(), docker(), dockerExec() (+37 more)

### Community 13 - "Community 13"
Cohesion: 0.04
Nodes (34): AdminApp(), ResolvedTheme, Theme, THEME_VALUES, ThemeProvider(), ThemeProviderContext, ThemeProviderProps, ThemeProviderState (+26 more)

### Community 14 - "Community 14"
Cohesion: 0.07
Nodes (46): BrowserLspClient, completionItems(), completionItemsToSuggestions(), documentationToMarkdown(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), initializeParams() (+38 more)

### Community 15 - "Community 15"
Cohesion: 0.05
Nodes (47): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 001: Sim Container Architecture, Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process (+39 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (48): 1. Find your host IP, 1. Login And Isolation, 2. Editor And Project Persistence, 2. Start the control plane, 3. Connect from other machines, 3. File Operations, 4. Firewall (if needed), 4. Java IDE Features (+40 more)

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (40): advantageScopeUrl(), appendConsole(), consoleEl, currentSessionUser(), editor, editorEl, envValue(), flushSave() (+32 more)

### Community 18 - "Community 18"
Cohesion: 0.11
Nodes (3): Robot, RunManager, TimedRobot

### Community 19 - "Community 19"
Cohesion: 0.08
Nodes (24): assert(), assertNt4AliveProbe(), assertSimProcessAlive(), buildingTimes, initializeLspSession(), latest, Login, logins (+16 more)

### Community 20 - "Community 20"
Cohesion: 0.07
Nodes (28): A.1 Install and configure betterauth, A.2 OAuth providers, A.3 Email allowlist, A.4 Cookie + session, A.5 Workspace creation on first login, A.6 Roles, A.7 Authorization architecture (default-deny), A.8.1 Contract/API migration (+20 more)

### Community 21 - "Community 21"
Cohesion: 0.17
Nodes (25): applyAdvantageScopePatches(), ascopeRoot, CommandResult, patchDir, patchFiles(), repoRoot, run(), ascopeLiteStatic (+17 more)

### Community 22 - "Community 22"
Cohesion: 0.08
Nodes (26): 1. Bootstrap shadcn — DONE, 1. Bootstrap shadcn first, 2. Path aliases and config cleanup, 3. Install initial primitives, 4. Add React Router 7, 4. Decompose `main.tsx`, 5. Decompose `main.tsx`, 5. State extraction (+18 more)

### Community 23 - "Community 23"
Cohesion: 0.08
Nodes (24): A.1 Config, A.2 Admission control, A.3 Admin override, A.4 Tests, A. Container concurrency cap, B.1 Schema, B.2 Recording helper, B.3 Admin UI (+16 more)

### Community 24 - "Community 24"
Cohesion: 0.09
Nodes (21): 0. Prove the HALSim WS contract, 1. Container-side: ensure HALSim WS extension is bundled, 2. Control-plane: HALSim WS proxy route, 3. Web: `useHalSim` hook, 4. Web: `DriverStation` component tree, 5. Replace `RunControls` and `ConsolePane` from Plan 03, 6. Safety logic, 7. Visual: SystemCore-ish look (+13 more)

### Community 25 - "Community 25"
Cohesion: 0.09
Nodes (20): 002 — AdvantageScope Lite hosted standalone, 1. `spawnSync(npmCmd, [...], { shell: false })` returns exit `null` on Windows, 2. AS Lite ships a `lite/static/` directory inside the submodule with `index.html` and `popups.css`, 3. Git symlinks under `lite/static/` checked out as 9-byte text files on Windows, 4. AS Lite expects `GET /assets` and `GET /assets/<name>/<file>` server routes, 5. AS submodule's `postinstall` is heavy, 6. AS upstream prints `npm audit` warnings about transitive vulns, AdvantageScope as a git submodule pinned to a release tag (+12 more)

### Community 26 - "Community 26"
Cohesion: 0.1
Nodes (20): code:text (vendor/AdvantageScope d2e915f580ca4ad9444a5211bf89fe71b128de), code:block10 (apps/web/              Vite browser shell with Monaco, AS Li), code:bash (git clone https://github.com/emscripten-core/emsdk.git), code:bash (export EMSDK=/path/to/emsdk    # bash), code:bash (git clone <this-repo>), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker exec frc-sim-mvp cat /workspace/project/src/main/java) (+12 more)

### Community 27 - "Community 27"
Cohesion: 0.1
Nodes (19): 001 — Sim container architecture, 1. Missing `WPILibNewCommands.json` vendor dep, 2. Dockerfile `|| true` swallowed gradle build failure, 3. Image size came in at 2.25 GB, not the 1.0–1.4 GB plan estimate, 4. Wrapper-zip warning is cosmetic, Context, Decisions, `eclipse-temurin:17-jdk-jammy` base image (+11 more)

### Community 28 - "Community 28"
Cohesion: 0.1
Nodes (20): code:text (vendor/AdvantageScope d2e915f580ca4ad9444a5211bf89fe71b128de), code:block10 (apps/web/              Vite browser shell with Monaco, AS Li), code:bash (git clone https://github.com/emscripten-core/emsdk.git), code:bash (export EMSDK=/path/to/emsdk    # bash), code:bash (git clone <this-repo>), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker exec frc-sim-mvp cat /workspace/project/src/main/java) (+12 more)

### Community 29 - "Community 29"
Cohesion: 0.11
Nodes (18): 10. Docs, 1. UX — import dialog, 2. Backend endpoint, 3. Validation, 4. Clone strategy, 5. Streaming feedback, 6. Backup / restore wiring, 7. Limits and quotas (+10 more)

### Community 30 - "Community 30"
Cohesion: 0.11
Nodes (17): 003 — Minimal web shell, 1. Headless preview screenshot hangs when AS Lite iframe is loading, 2. Orphaned Vite child after `TaskStop` on the npm wrapper, 3. `WARNING:StorageManager: settings timeout, using defaults` in the console, 4. AS Lite tab-controls panel was clipped (initial layout), AS Lite via iframe to `http://localhost:8080`, not bundled, code:block1 ("editor       scope"), Context (+9 more)

### Community 31 - "Community 31"
Cohesion: 0.11
Nodes (17): 006 - Multi-tenancy spike findings, code:text (alice alive 200 ok), code:bash (npm run spike:multi -- up), code:text (alice: websocket open=true, initialized=true, diagnostics=0), code:text (open=true, initialized=true), code:text (GET /file?user=alice -> 200), code:text (status building at 1 ms), code:text (sim container created in 0.29s) (+9 more)

### Community 32 - "Community 32"
Cohesion: 0.12
Nodes (13): CreateServerOptions, decoder, encoder, findLauncherJar(), firstConnectionWarmupMs, jdtLsArgs(), jdtLsLauncher(), LspSocketData (+5 more)

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (17): Auto-import on Tab (additionalTextEdits), code:dockerfile (FROM gitpod/openvscode-server:1.105.1), code:bash (cd /tmp/frc-spike-openvscode), Container boots and serves (:3000), Ctrl-click into library source (jdt:// URI), Decision 011: V2 Editor Spike — openvscode-server with redhat.java and WPILib, Decisions, Docker Hub vs GitHub Releases (+9 more)

### Community 36 - "Community 36"
Cohesion: 0.12
Nodes (16): Bind mounts, Build, code:bash (bun run docker:build:code), code:bash (FRC_UID=$(id -u) FRC_GID=$(id -g) bun run docker:build:code), code:block3 (frc-sim.managed=true), code:bash (docker run -d \), Environment variables, Example run (+8 more)

### Community 37 - "Community 37"
Cohesion: 0.12
Nodes (15): Architecture (MVP), code:block1 (+----------------------------------+), Explicitly deferred to post-MVP, FRC Web Simulator: Project Summary and MVP Spec, MVP scope, Note to the implementing agent, Overall MVP definition of done, Project summary (+7 more)

### Community 38 - "Community 38"
Cohesion: 0.33
Nodes (14): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+6 more)

### Community 39 - "Community 39"
Cohesion: 0.12
Nodes (15): Architecture (MVP), code:block1 (+----------------------------------+), Explicitly deferred to post-MVP, FRC Web Simulator: Project Summary and MVP Spec, MVP scope, Note to the implementing agent, Overall MVP definition of done, Project summary (+7 more)

### Community 40 - "Community 40"
Cohesion: 0.12
Nodes (14): Build, code:bash (docker build -t frc-sim:mvp containers/sim), code:bash (docker run --rm -p 5810:5810 --memory=2g --name frc-sim frc-), code:block3 (NT: server: listening on NT4 port 5810), code:bash (docker stop frc-sim), Hacking, Run, Runtime Contract (+6 more)

### Community 41 - "Community 41"
Cohesion: 0.13
Nodes (14): 1. Remove `cleanupV1Containers()`, 2. Drop V1 columns from `container_leases`, 3. Rename cookie and default secret, 4. Archive MVP docs and delete `mvp/` source, 5. Archive obsolete V1 decisions, 6. Scrub references to `mvp/` and V1, 7. Remove status-tracker entry for V1 cruft, Context (+6 more)

### Community 42 - "Community 42"
Cohesion: 0.13
Nodes (14): 1. Remove the build queue, 2. Remove `RUN_CONCURRENCY`, 3. Split `app.test.ts`, 4. Drop redundant / V1 tests, 5. Delete one-shot verification scripts, 6. Audit env vars, 7. Update `docs/runbook.md`, Context (+6 more)

### Community 43 - "Community 43"
Cohesion: 0.14
Nodes (13): Context, Definition of done, Experiments, Goals, Key questions, Multi-Tenancy Spike, Non-goals, Q1: NT4 routing under multi-tenancy (+5 more)

### Community 44 - "Community 44"
Cohesion: 0.14
Nodes (3): Intentional Template Contents, Provenance, WPILib Java Command Starter Template

### Community 45 - "Community 45"
Cohesion: 0.14
Nodes (13): Context, Definition of done, Experiments, Goals, Key questions, Multi-Tenancy Spike, Non-goals, Q1: NT4 routing under multi-tenancy (+5 more)

### Community 46 - "Community 46"
Cohesion: 0.15
Nodes (12): code:json ({ "type": "<MessageType>", "device": "<DeviceId>", "data": {), Context, Decision, Decision 015 — HALSim WebSocket Control Protocol, DriverStation message (`type: "DriverStation"`, `device: ""`), Future hooks, Joystick message (`type: "Joystick"`, `device: "<N>"`), Message envelope (+4 more)

### Community 47 - "Community 47"
Cohesion: 0.15
Nodes (12): 009 - LSP reconnect, bridge serialization, and startup throttling, Context, Decision 1: Browser LSP client auto-reconnects with bounded backoff, Decision 2: Bridge serializes JDT LS spawns, Decision 3: Orchestrator-level LSP startup throttle, Decision 4: Cap proxy pending-message buffers, Decision 5: NT4 subprotocol mismatch is fail-fast, not silent, Decision 6: AS Lite in-iframe timeout banner (+4 more)

### Community 48 - "Community 48"
Cohesion: 0.15
Nodes (12): 009 - LSP reconnect, bridge serialization, and startup throttling, Context, Decision 1: Browser LSP client auto-reconnects with bounded backoff, Decision 2: Bridge serializes JDT LS spawns, Decision 3: Orchestrator-level LSP startup throttle, Decision 4: Cap proxy pending-message buffers, Decision 5: NT4 subprotocol mismatch is fail-fast, not silent, Decision 6: AS Lite in-iframe timeout banner (+4 more)

### Community 49 - "Community 49"
Cohesion: 0.26
Nodes (11): ascopeRoot, assert(), createTemplate(), distDir, exists(), patchDir, repoRoot, runGit() (+3 more)

### Community 50 - "Community 50"
Cohesion: 0.17
Nodes (11): Automated Verification, code:block1 (bun run measure), code:bash (bun run typecheck), Comparison with V1, Decision, Decision 013: V2 Acceptance Pass, Host Capacity (10 students), Manual Verification (+3 more)

### Community 51 - "Community 51"
Cohesion: 0.29
Nodes (10): children, ensureContainer(), ensureLspContainer(), ensureSimContainer(), repoRoot, runCommand(), shutdown(), startProcess() (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.27
Nodes (10): ContainerStats, dockerRun(), getContainerStats(), getDiskInfo(), getHostInfo(), HostInfo, jsonOutput, main() (+2 more)

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (9): 004 - Backend wiring for save and run, Context, Custom WebSocket sender, no new dependency, Decisions, Host backend plus Docker CLI, Minimal endpoints and run protocol, One-command dev stack without Docker Compose, Replaceable sim process inside long-lived container (+1 more)

### Community 54 - "Community 54"
Cohesion: 0.18
Nodes (10): Base image: `gitpod/openvscode-server:1.105.1`, Consequences, Context, Decision, Decision 012: V2 Code Image — Base Image and Extension Strategy, Direct launch base path handling, Extension cache seeding pattern, Extensions: download at build time (+2 more)

### Community 55 - "Community 55"
Cohesion: 0.18
Nodes (9): app, AssetManifest, buildAssetManifest(), bundledAssetsDir, distDir, port, rel, repoRoot (+1 more)

### Community 56 - "Community 56"
Cohesion: 0.31
Nodes (9): code:powershell (git submodule update --init --recursive), code:text (apps/control/                  Bun control plane with login,), Commands, FRC Web Simulator, FRC Web Simulator V1, Layout, Operator Runbook, Prerequisites (+1 more)

### Community 57 - "Community 57"
Cohesion: 0.2
Nodes (9): 007 - V1 sim container orchestration, code:text (frc-sim.managed=true), Context, Decisions, Docker labels are adopted back into SQLite, Lazy ensure, visible status, Loopback-only published ports, Runtime cache seed (+1 more)

### Community 58 - "Community 58"
Cohesion: 0.2
Nodes (9): 008 - V1 LSP container and Bun-native bridge, Browser LSP client extended for multi-file projects, Bun-native bridge instead of `vscode-ws-jsonrpc`, code:block1 (data/users/<workspaceId>/project    -> /workspace/project), `container_leases` lease state split, Context, Decisions, Generic `ContainerOrchestrator` (+1 more)

### Community 59 - "Community 59"
Cohesion: 0.2
Nodes (9): 007 - V1 sim container orchestration, code:text (frc-sim.managed=true), Context, Decisions, Docker labels are adopted back into SQLite, Lazy ensure, visible status, Loopback-only published ports, Runtime cache seed (+1 more)

### Community 60 - "Community 60"
Cohesion: 0.2
Nodes (9): 008 - V1 LSP container and Bun-native bridge, Browser LSP client extended for multi-file projects, Bun-native bridge instead of `vscode-ws-jsonrpc`, code:block1 (data/users/<workspaceId>/project    -> /workspace/project), `container_leases` lease state split, Context, Decisions, Generic `ContainerOrchestrator` (+1 more)

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (7): 005 - Java LSP MVP integration, Context, Decisions, Local WPILib-aware JDT LS image, Package and Vite choices, Plain Monaco client with direct LSP requests, Verification

### Community 62 - "Community 62"
Cohesion: 0.25
Nodes (5): home, projectRoot, robotJar, sleeper, stop

### Community 63 - "Community 63"
Cohesion: 0.46
Nodes (7): dirExists(), fileExists(), main(), parseArgs(), restoreArchive(), restoreDirectory(), runTar()

### Community 64 - "Community 64"
Cohesion: 0.25
Nodes (7): code:block1 (01 ──┐), Conventions for each plan doc, Decisions baked in from the planning conversation, Dependency graph, Out of scope for this whole batch, Post-V2 Plan, The plans

### Community 65 - "Community 65"
Cohesion: 0.29
Nodes (6): children, repoRoot, shutdown(), startProcess(), tsxCli, viteCli

### Community 66 - "Community 66"
Cohesion: 0.29
Nodes (4): [command, email], db, UserRow, users

### Community 67 - "Community 67"
Cohesion: 0.6
Nodes (5): dirExists(), main(), parseArgs(), runTar(), timestamp()

### Community 68 - "Community 68"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 69 - "Community 69"
Cohesion: 0.33
Nodes (5): Adding components, code:bash (npx shadcn@latest add button), code:tsx (import { Button } from "@/components/ui/button"), React + TypeScript + Vite + shadcn/ui, Using components

### Community 70 - "Community 70"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 71 - "Community 71"
Cohesion: 0.33
Nodes (4): args, gid, subprocess, uid

### Community 72 - "Community 72"
Cohesion: 0.5
Nodes (4): dryRun, main(), repoRoot, run()

### Community 73 - "Community 73"
Cohesion: 0.4
Nodes (4): Consequences, Context, Decision, Decision 014 — Better Auth Integration

### Community 74 - "Community 74"
Cohesion: 0.4
Nodes (4): 010 - Gradle project cache isolation for sim and LSP, Context, Decisions, Implications

### Community 75 - "Community 75"
Cohesion: 0.4
Nodes (4): hubBundle, replacements, repoRoot, source

### Community 76 - "Community 76"
Cohesion: 0.4
Nodes (4): 010 - Gradle project cache isolation for sim and LSP, Context, Decisions, Implications

### Community 78 - "Community 78"
Cohesion: 0.5
Nodes (3): Intentional Template Contents, Provenance, WPILib Java Command Starter Template

## Knowledge Gaps
- **1090 isolated node(s):** `workspaceSlugSchema`, `userIdSchema`, `workspaceIdSchema`, `displayNameSchema`, `workspaceRouteSchema` (+1085 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `isWorkspaceSlug()` connect `Community 13` to `Community 3`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `App()` connect `Community 13` to `Community 12`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **What connects `workspaceSlugSchema`, `userIdSchema`, `workspaceIdSchema` to the rest of the system?**
  _1090 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._