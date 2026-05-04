# Graph Report - FRC-Programming-Training-Sim  (2026-05-04)

## Corpus Check
- 37 files · ~36,210 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 301 nodes · 553 edges · 20 communities detected
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 14 edges (avg confidence: 0.83)
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
- [[_COMMUNITY_Community 28|Community 28]]

## God Nodes (most connected - your core abstractions)
1. `AppStorage` - 15 edges
2. `isObject()` - 13 edges
3. `startJavaLsp()` - 10 edges
4. `BrowserLspClient` - 10 edges
5. `MVP Backend Service (mvp/apps/server/src/main.ts)` - 10 edges
6. `WebSocketTextPeer` - 9 edges
7. `registerDefaultDarkModernTheme()` - 8 edges
8. `main()` - 8 edges
9. `Web Shell Entry (mvp/apps/web/src/main.ts)` - 8 edges
10. `Robot.java (sim project source of truth)` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Shared vs. Per-user JDT LS topology (spike question)` --conceptually_related_to--> `LSP WebSocket Bridge (mvp/apps/lsp/src/main.ts)`  [INFERRED]
  mvp/Spike-Multi-Tenancy.md → mvp/apps/lsp/src/main.ts
- `Decision 002: AdvantageScope Lite Hosting` --references--> `build-ascope-lite.ts script`  [EXTRACTED]
  mvp/docs/decisions/002-advantagescope-lite-hosting.md → mvp/scripts/build-ascope-lite.ts
- `createApp()` --calls--> `createStorage()`  [INFERRED]
  apps\control\src\app.ts → apps\control\src\storage.ts
- `Decision 005: Java LSP MVP Integration` --references--> `LSP WebSocket Bridge (mvp/apps/lsp/src/main.ts)`  [EXTRACTED]
  mvp/docs/decisions/005-java-lsp.md → mvp/apps/lsp/src/main.ts
- `Decision 004: Backend Wiring for Save and Run` --references--> `MVP Backend Service (mvp/apps/server/src/main.ts)`  [EXTRACTED]
  mvp/docs/decisions/004-backend-wiring.md → mvp/apps/server/src/main.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (29 total, 6 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (46): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 001: Sim Container Architecture, Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process (+38 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (23): BrowserLspClient, completionItems(), completionItemsToSuggestions(), documentationToMarkdown(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), initializeParams() (+15 more)

### Community 2 - "Community 2"
Cohesion: 0.14
Nodes (20): acceptWebSocket(), collectProcess(), delay(), docker(), dockerExec(), handleRun(), killChild(), killChildren() (+12 more)

### Community 3 - "Community 3"
Cohesion: 0.13
Nodes (13): loadControlConfig(), applyMigrations(), ensureMigrationTable(), listAppliedMigrations(), loadMigrations(), migrationStatus(), verifyAppliedMigrationChecksums(), AppStorage (+5 more)

### Community 4 - "Community 4"
Cohesion: 0.17
Nodes (14): authFromRequest(), escapeHtml(), htmlResponse(), loginPage(), redirect(), resolveWorkspaceRequest(), workspacePage(), base64Url() (+6 more)

### Community 5 - "Community 5"
Cohesion: 0.27
Nodes (17): advantageScopeUrl(), appendConsole(), currentSessionUser(), envValue(), flushSave(), handleRunMessage(), javaLanguageServerUrl(), loadRobotJava() (+9 more)

### Community 6 - "Community 6"
Cohesion: 0.4
Nodes (9): setupMonaco(), colorForMonacoTokenRule(), directSemanticRules(), findTextMateSettings(), registerDefaultDarkModernTheme(), semanticFallbackRules(), textMateScopeMatches(), toRule() (+1 more)

### Community 7 - "Community 7"
Cohesion: 0.44
Nodes (11): compileLite(), compileWasm(), ensureEmscripten(), ensureSubmodule(), envWithEmsdk(), listGitSymlinksUnder(), main(), npmInstallSubmodule() (+3 more)

### Community 8 - "Community 8"
Cohesion: 0.47
Nodes (11): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+3 more)

### Community 9 - "Community 9"
Cohesion: 0.29
Nodes (6): getProjectPathAccess(), isProjectPath(), isWorkspaceSlug(), matchesPathOrChild(), parseProjectPath(), App()

### Community 10 - "Community 10"
Cohesion: 0.32
Nodes (3): createApp(), createTemplate(), withApp()

### Community 11 - "Community 11"
Cohesion: 0.43
Nodes (6): nt4HttpUrl(), nt4WsUrl(), parseSessions(), pipeWebSockets(), requestedProtocols(), sessionFromPath()

### Community 12 - "Community 12"
Cohesion: 0.54
Nodes (6): ensureContainer(), ensureLspContainer(), ensureSimContainer(), runCommand(), shutdown(), startProcess()

### Community 14 - "Community 14"
Cohesion: 0.6
Nodes (3): asWebSocket(), handleUpgrade(), launchLanguageServer()

## Knowledge Gaps
- **10 isolated node(s):** `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (mvp/apps/web/vite.config.ts)`, `Main.java (WPILib entry point)`, `Web Shell index.html` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AppStorage` connect `Community 3` to `Community 4`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (mvp/apps/web/vite.config.ts)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._