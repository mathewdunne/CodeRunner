# Graph Report - FRC-Programming-Training-Sim  (2026-05-05)

## Corpus Check
- 51 files · ~53,719 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 465 nodes · 878 edges · 22 communities detected
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 20 edges (avg confidence: 0.82)
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
- [[_COMMUNITY_Community 29|Community 29]]

## God Nodes (most connected - your core abstractions)
1. `AppStorage` - 25 edges
2. `RunManager` - 20 edges
3. `ContainerOrchestrator` - 19 edges
4. `resolveProjectFilePath()` - 13 edges
5. `isObject()` - 13 edges
6. `main()` - 11 edges
7. `apiError()` - 10 edges
8. `startJavaLsp()` - 10 edges
9. `BrowserLspClient` - 10 edges
10. `MVP Backend Service (mvp/apps/server/src/main.ts)` - 10 edges

## Surprising Connections (you probably didn't know these)
- `readProjectTreeNode()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps\control\src\app.ts → packages\contracts\src\index.ts
- `resolveProjectFilePath()` --calls--> `getProjectPathAccess()`  [INFERRED]
  apps\control\src\app.ts → packages\contracts\src\index.ts
- `createApp()` --calls--> `createStorage()`  [INFERRED]
  apps\control\src\app.ts → apps\control\src\storage.ts
- `withApp()` --calls--> `createApp()`  [INFERRED]
  apps\control\src\app.test.ts → apps\control\src\app.ts
- `authFromRequest()` --calls--> `parseSignedSessionCookie()`  [INFERRED]
  apps\control\src\app.ts → apps\control\src\cookies.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (30 total, 6 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (44): apiError(), apiErrorResponse(), assertRealPathInside(), authFromRequest(), contentTypeFor(), createProjectEntry(), deleteProjectEntry(), escapeHtml() (+36 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (47): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 001: Sim Container Architecture, Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process (+39 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (18): defaultContainerUser(), loadControlConfig(), parseBoolean(), parsePortRange(), parsePositiveInteger(), applyMigrations(), ensureMigrationTable(), listAppliedMigrations() (+10 more)

### Community 3 - "Community 3"
Cohesion: 0.15
Nodes (23): BrowserLspClient, completionItems(), completionItemsToSuggestions(), documentationToMarkdown(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), initializeParams() (+15 more)

### Community 4 - "Community 4"
Cohesion: 0.14
Nodes (20): acceptWebSocket(), collectProcess(), delay(), docker(), dockerExec(), handleRun(), killChild(), killChildren() (+12 more)

### Community 5 - "Community 5"
Cohesion: 0.17
Nodes (26): advantageScopeUrl(), appendConsole(), currentSessionUser(), envValue(), flushSave(), handleRunMessage(), javaLanguageServerUrl(), loadRobotJava() (+18 more)

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (13): ContainerOrchestrator, containerRuntimeState(), defaultDockerRunner(), dockerError(), dockerPortBindError(), isLoopbackHost(), labelsMatch(), portIsFree() (+5 more)

### Community 7 - "Community 7"
Cohesion: 0.09
Nodes (12): getProjectPathAccess(), isProjectPath(), isWorkspaceSlug(), matchesPathOrChild(), parseProjectPath(), App(), fetchJson(), fileName() (+4 more)

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (12): assert(), createTemplate(), exists(), runGit(), verifyPatchFiles(), verifyScopeServing(), verifyStagedBundle(), createApp() (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.18
Nodes (7): consumeLines(), defaultRunCommandFactory(), dockerRunScript(), lineLooksReady(), randomRunId(), runLogPath(), RunManager

### Community 10 - "Community 10"
Cohesion: 0.29
Nodes (16): applyAdvantageScopePatches(), patchFiles(), run(), compileLite(), compileWasm(), ensureEmscripten(), ensureSubmodule(), envWithEmsdk() (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.47
Nodes (11): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.26
Nodes (7): assert(), assertSimProcessAlive(), login(), readProjectFile(), removeManagedContainers(), runCommand(), writeProjectFile()

### Community 14 - "Community 14"
Cohesion: 0.43
Nodes (6): nt4HttpUrl(), nt4WsUrl(), parseSessions(), pipeWebSockets(), requestedProtocols(), sessionFromPath()

### Community 15 - "Community 15"
Cohesion: 0.54
Nodes (6): ensureContainer(), ensureLspContainer(), ensureSimContainer(), runCommand(), shutdown(), startProcess()

### Community 18 - "Community 18"
Cohesion: 0.6
Nodes (3): asWebSocket(), handleUpgrade(), launchLanguageServer()

## Knowledge Gaps
- **10 isolated node(s):** `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (mvp/apps/web/vite.config.ts)`, `Main.java (WPILib entry point)`, `Web Shell index.html` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RunManager` connect `Community 9` to `Community 0`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Why does `createApp()` connect `Community 8` to `Community 0`, `Community 2`, `Community 12`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Why does `AppStorage` connect `Community 2` to `Community 0`, `Community 9`, `Community 6`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **What connects `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (mvp/apps/web/vite.config.ts)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._