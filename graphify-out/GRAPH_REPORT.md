# Graph Report - .  (2026-05-03)

## Corpus Check
- Corpus is ~19,163 words - fits in a single context window. You may not need a graph.

## Summary
- 174 nodes · 260 edges · 12 communities detected
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Backend Server & Docker Wiring|Backend Server & Docker Wiring]]
- [[_COMMUNITY_Sim Container Architecture|Sim Container Architecture]]
- [[_COMMUNITY_Web Shell & Editor UI|Web Shell & Editor UI]]
- [[_COMMUNITY_Java LSP Client Layer|Java LSP Client Layer]]
- [[_COMMUNITY_Robot Code & Build Pipeline|Robot Code & Build Pipeline]]
- [[_COMMUNITY_Project Docs & AS Lite Hosting|Project Docs & AS Lite Hosting]]
- [[_COMMUNITY_LSP WebSocket Bridge|LSP WebSocket Bridge]]
- [[_COMMUNITY_Browser LSP Client|Browser LSP Client]]
- [[_COMMUNITY_Dev Stack Container Management|Dev Stack Container Management]]
- [[_COMMUNITY_WPILib Main Entry|WPILib Main Entry]]
- [[_COMMUNITY_Robot Container Class|Robot Container Class]]
- [[_COMMUNITY_Web Shell HTML Entry|Web Shell HTML Entry]]

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
10. `startJavaLsp()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Shared vs. Per-user JDT LS topology (spike question)` --conceptually_related_to--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [INFERRED]
  Spike-Multi-Tenancy.md → apps/lsp/src/main.ts
- `Decision 003: Minimal Web Shell` --references--> `Web Shell Entry (apps/web/src/main.ts)`  [EXTRACTED]
  docs/decisions/003-web-shell.md → apps/web/src/main.ts
- `Project-MVP.md (MVP Spec)` --references--> `Robot.java (sim project source of truth)`  [EXTRACTED]
  Project-MVP.md → containers/sim/project/src/main/java/frc/robot/Robot.java
- `Decision 002: AdvantageScope Lite Hosting` --references--> `build-ascope-lite.ts script`  [EXTRACTED]
  docs/decisions/002-advantagescope-lite-hosting.md → scripts/build-ascope-lite.ts
- `Decision 005: Java LSP MVP Integration` --references--> `LSP WebSocket Bridge (apps/lsp/src/main.ts)`  [EXTRACTED]
  docs/decisions/005-java-lsp.md → apps/lsp/src/main.ts

## Hyperedges (group relationships)
- **Edit-Save-Run-Sim Loop (core MVP end-to-end flow)** — web_main_entry, server_main_backendservice, robot_java, server_main_handlerun [EXTRACTED 1.00]
- **Java LSP Intelligence Stack (browser to JDT LS)** — web_javalsp_startjavalsp, web_javalsp_browserlspclient, lsp_main_lspbridge, lsp_main_eclipsejdtls [EXTRACTED 1.00]
- **AdvantageScope Lite NT4 Hosting and Display** — scripts_buildascope, scripts_serveascope, rationale_aslite_hostname, index_html [EXTRACTED 0.95]

## Communities (15 total, 3 thin omitted)

### Community 0 - "Backend Server & Docker Wiring"
Cohesion: 0.12
Nodes (15): collectProcess(), docker(), dockerExec(), handleRun(), killChild(), killChildren(), LineSplitter, makeTextFrameHeader() (+7 more)

### Community 1 - "Sim Container Architecture"
Cohesion: 0.1
Nodes (24): Decision 001: Sim Container Architecture, Decision 004: Backend Wiring for Save and Run, Main.java (WPILib entry point), Rationale: Custom WebSocket sender without @fastify/websocket, Rationale: Headless sim via omission (no SimGUI/DriverStation), Rationale: Single-stage Dockerfile to preserve Gradle cache, Rationale: tini as PID 1 in sim container to reap zombie processes, Robot.java (sim project source of truth) (+16 more)

### Community 2 - "Web Shell & Editor UI"
Cohesion: 0.16
Nodes (13): appendConsole(), flushSave(), handleRunMessage(), saveRobotJava(), setStatus(), setupMonaco(), colorForMonacoTokenRule(), directSemanticRules() (+5 more)

### Community 3 - "Java LSP Client Layer"
Cohesion: 0.19
Nodes (16): completionItems(), completionItemsToSuggestions(), handleDiagnostics(), hoverContentsToMarkdown(), hoverToMonaco(), isCompletionItem(), isLspDiagnostic(), isObject() (+8 more)

### Community 4 - "Robot Code & Build Pipeline"
Cohesion: 0.21
Nodes (13): Robot, compileLite(), compileWasm(), ensureEmscripten(), ensureSubmodule(), envWithEmsdk(), listGitSymlinksUnder(), main() (+5 more)

### Community 5 - "Project Docs & AS Lite Hosting"
Cohesion: 0.18
Nodes (12): NT4 Routing under Multi-Tenancy (spike question), Shared vs. Per-user JDT LS topology (spike question), Decision 002: AdvantageScope Lite Hosting, Decision 003: Minimal Web Shell, Project-MVP.md (MVP Spec), Rationale: AS Lite embedded via iframe, not bundled into web app, Rationale: AS Lite reads window.location.hostname for NT4, build-ascope-lite.ts script (+4 more)

### Community 6 - "LSP WebSocket Bridge"
Cohesion: 0.2
Nodes (10): Decision 005: Java LSP MVP Integration, Eclipse JDT LS Process, handleUpgrade(), launchLanguageServer(), LSP WebSocket Bridge (apps/lsp/src/main.ts), Rationale: No Cross-Origin-Embedder-Policy headers (AS Lite iframe), Rationale: Plain Monaco client with direct LSP requests instead of TypeFox wrappers, BrowserLspClient class (+2 more)

### Community 7 - "Browser LSP Client"
Cohesion: 0.27
Nodes (3): BrowserLspClient, initializeParams(), startJavaLsp()

### Community 8 - "Dev Stack Container Management"
Cohesion: 0.43
Nodes (4): ensureContainer(), ensureLspContainer(), ensureSimContainer(), runCommand()

## Knowledge Gaps
- **10 isolated node(s):** `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)`, `Main.java (WPILib entry point)`, `Web Shell index.html` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Robot.java (sim project source of truth)` connect `Sim Container Architecture` to `Project Docs & AS Lite Hosting`, `LSP WebSocket Bridge`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `startJavaLsp()` connect `LSP WebSocket Bridge` to `Sim Container Architecture`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **What connects `Eclipse JDT LS Process`, `LineSplitter class`, `Vite Config (apps/web/vite.config.ts)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Backend Server & Docker Wiring` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Sim Container Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._