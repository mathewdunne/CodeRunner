# Graph Report - FRC-Programming-Training-Sim  (2026-05-03)

## Corpus Check
- 18 files · ~22,352 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 207 nodes · 313 edges · 13 communities detected
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.85)
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
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 18|Community 18]]

## God Nodes (most connected - your core abstractions)
1. `isObject()` - 12 edges
2. `MVP Backend Service (apps/server/src/main.ts)` - 10 edges
3. `BrowserLspClient` - 9 edges
4. `WebSocketTextPeer` - 8 edges
5. `startJavaLsp()` - 8 edges
6. `Web Shell Entry (apps/web/src/main.ts)` - 8 edges
7. `Robot.java (sim project source of truth)` - 8 edges
8. `main()` - 7 edges
9. `registerDefaultDarkModernTheme()` - 6 edges
10. `run()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Shared vs. Per-user JDT LS topology (spike question)` --conceptually_related_to--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [INFERRED]
  Spike-Multi-Tenancy.md → apps/lsp/src/main.ts
- `Project-MVP.md (MVP Spec)` --references--> `Robot.java (sim project source of truth)`  [EXTRACTED]
  Project-MVP.md → containers/sim/project/src/main/java/frc/robot/Robot.java
- `Decision 002: AdvantageScope Lite Hosting` --references--> `build-ascope-lite.ts script`  [EXTRACTED]
  docs/decisions/002-advantagescope-lite-hosting.md → scripts/build-ascope-lite.ts
- `Decision 005: Java LSP MVP Integration` --references--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [EXTRACTED]
  docs/decisions/005-java-lsp.md → apps/lsp/src/main.ts
- `Decision 004: Backend Wiring for Save and Run` --references--> `MVP Backend Service (apps/server/src/main.ts)`  [EXTRACTED]
  docs/decisions/004-backend-wiring.md → apps/server/src/main.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (19 total, 3 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (29): Decision 001: Sim Container Architecture, Decision 003: Minimal Web Shell, Decision 004: Backend Wiring for Save and Run, Main.java (WPILib entry point), Rationale: AS Lite embedded via iframe, not bundled into web app, Rationale: Custom WebSocket sender without @fastify/websocket, Rationale: Headless sim via omission (no SimGUI/DriverStation), Rationale: Single-stage Dockerfile to preserve Gradle cache (+21 more)

### Community 1 - "Community 1"
Cohesion: 0.1
Nodes (17): collectProcess(), docker(), dockerExec(), handleRun(), killChild(), killChildren(), LineSplitter, makeTextFrameHeader() (+9 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (22): advantageScopeUrl(), appendConsole(), envValue(), flushSave(), handleRunMessage(), javaLanguageServerUrl(), loadRobotJava(), parsePortMap() (+14 more)

### Community 3 - "Community 3"
Cohesion: 0.19
Nodes (16): completionItems(), completionItemsToSuggestions(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), isCompletionItem(), isLspDiagnostic(), isObject() (+8 more)

### Community 4 - "Community 4"
Cohesion: 0.21
Nodes (13): Robot, compileLite(), compileWasm(), ensureEmscripten(), ensureSubmodule(), envWithEmsdk(), listGitSymlinksUnder(), main() (+5 more)

### Community 5 - "Community 5"
Cohesion: 0.39
Nodes (11): containerState(), dockerStats(), down(), ensureContainer(), lifecycle(), main(), parseMiB(), printEnv() (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.2
Nodes (10): Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process, handleUpgrade(), launchLanguageServer(), LSP WebSocket Bridge (apps/lsp/src/main.ts), Rationale: No Cross-Origin-Embedder-Policy headers (AS Lite iframe), Rationale: Plain Monaco client with direct LSP requests instead of TypeFox wrappers, BrowserLspClient class (+2 more)

### Community 7 - "Community 7"
Cohesion: 0.27
Nodes (3): BrowserLspClient, initializeParams(), startJavaLsp()

### Community 8 - "Community 8"
Cohesion: 0.31
Nodes (7): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 002: AdvantageScope Lite Hosting, Project-MVP.md (MVP Spec), Rationale: AS Lite reads window.location.hostname for NT4, build-ascope-lite.ts script, serve-ascope-lite.ts script

### Community 10 - "Community 10"
Cohesion: 0.43
Nodes (4): ensureContainer(), ensureLspContainer(), ensureSimContainer(), runCommand()

## Knowledge Gaps
- **10 isolated node(s):** `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)`, `Main.java (WPILib entry point)`, `Web Shell index.html` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Robot.java (sim project source of truth)` connect `Community 0` to `Community 8`, `Community 6`?**
  _High betweenness centrality (0.028) - this node is a cross-community bridge._
- **Why does `startJavaLsp()` connect `Community 6` to `Community 0`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._