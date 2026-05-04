# Graph Report - FRC-Programming-Training-Sim  (2026-05-04)

## Corpus Check
- 28 files · ~32,149 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 237 nodes · 441 edges · 18 communities detected
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.84)
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
- [[_COMMUNITY_Community 26|Community 26]]

## God Nodes (most connected - your core abstractions)
1. `isObject()` - 13 edges
2. `startJavaLsp()` - 10 edges
3. `BrowserLspClient` - 10 edges
4. `MVP Backend Service (apps/server/src/main.ts)` - 10 edges
5. `WebSocketTextPeer` - 9 edges
6. `registerDefaultDarkModernTheme()` - 8 edges
7. `main()` - 8 edges
8. `Web Shell Entry (apps/web/src/main.ts)` - 8 edges
9. `Robot.java (sim project source of truth)` - 8 edges
10. `run()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `Shared vs. Per-user JDT LS topology (spike question)` --conceptually_related_to--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [INFERRED]
  Spike-Multi-Tenancy.md → apps/lsp/src/main.ts
- `Decision 002: AdvantageScope Lite Hosting` --references--> `build-ascope-lite.ts script`  [EXTRACTED]
  docs/decisions/002-advantagescope-lite-hosting.md → scripts/build-ascope-lite.ts
- `Decision 005: Java LSP MVP Integration` --references--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [EXTRACTED]
  docs/decisions/005-java-lsp.md → apps/lsp/src/main.ts
- `Decision 004: Backend Wiring for Save and Run` --references--> `MVP Backend Service (apps/server/src/main.ts)`  [EXTRACTED]
  docs/decisions/004-backend-wiring.md → apps/server/src/main.ts
- `Rationale: Custom WebSocket sender without @fastify/websocket` --rationale_for--> `WebSocketTextPeer class`  [EXTRACTED]
  docs/decisions/004-backend-wiring.md → apps/server/src/main.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (27 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (36): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 001: Sim Container Architecture, Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Main.java (WPILib entry point), Project-MVP.md (MVP Spec) (+28 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (23): BrowserLspClient, completionItems(), completionItemsToSuggestions(), documentationToMarkdown(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), initializeParams() (+15 more)

### Community 2 - "Community 2"
Cohesion: 0.14
Nodes (20): acceptWebSocket(), collectProcess(), delay(), docker(), dockerExec(), handleRun(), killChild(), killChildren() (+12 more)

### Community 3 - "Community 3"
Cohesion: 0.27
Nodes (17): advantageScopeUrl(), appendConsole(), currentSessionUser(), envValue(), flushSave(), handleRunMessage(), javaLanguageServerUrl(), loadRobotJava() (+9 more)

### Community 4 - "Community 4"
Cohesion: 0.4
Nodes (9): setupMonaco(), colorForMonacoTokenRule(), directSemanticRules(), findTextMateSettings(), registerDefaultDarkModernTheme(), semanticFallbackRules(), textMateScopeMatches(), toRule() (+1 more)

### Community 5 - "Community 5"
Cohesion: 0.44
Nodes (11): compileLite(), compileWasm(), ensureEmscripten(), ensureSubmodule(), envWithEmsdk(), listGitSymlinksUnder(), main(), npmInstallSubmodule() (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.47
Nodes (11): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+3 more)

### Community 7 - "Community 7"
Cohesion: 0.2
Nodes (10): Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process, handleUpgrade(), launchLanguageServer(), LSP WebSocket Bridge (apps/lsp/src/main.ts), Rationale: No Cross-Origin-Embedder-Policy headers (AS Lite iframe), Rationale: Plain Monaco client with direct LSP requests instead of TypeFox wrappers, BrowserLspClient class (+2 more)

### Community 8 - "Community 8"
Cohesion: 0.43
Nodes (6): nt4HttpUrl(), nt4WsUrl(), parseSessions(), pipeWebSockets(), requestedProtocols(), sessionFromPath()

### Community 9 - "Community 9"
Cohesion: 0.54
Nodes (6): ensureContainer(), ensureLspContainer(), ensureSimContainer(), runCommand(), shutdown(), startProcess()

### Community 11 - "Community 11"
Cohesion: 0.6
Nodes (3): asWebSocket(), handleUpgrade(), launchLanguageServer()

## Knowledge Gaps
- **10 isolated node(s):** `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)`, `Main.java (WPILib entry point)`, `Web Shell index.html` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Robot.java (sim project source of truth)` connect `Community 0` to `Community 7`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `startJavaLsp()` connect `Community 7` to `Community 0`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **What connects `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._