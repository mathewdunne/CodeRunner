# 006 - Multi-tenancy spike findings

**Status:** Spike complete enough for V1 planning  
**Date:** 2026-05-03

## Context

`Spike-Multi-Tenancy.md` asked whether the single-user MVP shape can survive roughly 10 concurrent students. The load-bearing questions were NT4 routing and JDT LS topology; resource and lifecycle measurements were taken far enough to size a first V1 design.

The spike code is intentionally disposable and should be treated as evidence, not production architecture:

- `apps/router` - tiny NT4 WebSocket path router.
- `scripts/patch-ascope-lite-nt4-proxy.ts` - generated-bundle patch for AS Lite query params.
- `scripts/spike-multi-tenancy.ts` - starts/measures three hardcoded student containers.
- `scripts/dev-spike-multi-tenancy.ts` - starts the host dev services with spike env vars.
- `apps/server` and `apps/web` gained minimal `?user=` support while preserving single-user defaults.

## Recommendation

V1 should use per-student sim containers and per-student JDT LS containers, routed by a small session router. Use URL-path session identity at the edge (`/u/<session>/...`) and translate it to container names internally. Keep query-param identity only as a dev/spike convenience.

For NT4, use a WebSocket path router and maintain a small AS Lite fork/patch that lets the embedded Lite page read its NT4 HTTP-alive and WebSocket endpoints from query params or postMessage. Avoid port-per-user in the browser-facing API; it works locally but turns deployment, firewalls, and TLS into busywork.

## Q1: NT4 routing under multi-tenancy

Chosen V1 direction: **WS proxy demuxing by path**, plus a minimal AS Lite endpoint patch.

What worked:

- `apps/router` serves `/sim/<user>/alive` and `/sim/<user>/nt4`.
- `/sim/<user>/alive` checks the target NT4 HTTP endpoint.
- `/sim/<user>/nt4` proxies WebSocket bytes to the right sim container at `/nt/AdvantageScopeLite`.
- `scripts/patch-ascope-lite-nt4-proxy.ts` patches the generated `hub.js` so AS Lite can use:
  - `?nt4Origin=http://localhost:4100`
  - `?nt4Path=/sim/alice/nt4`

Evidence:

```text
alice alive 200 ok
bob alive 200 ok
charlie alive 200 ok
ws open protocol v4.1.networktables.first.wpi.edu
```

Required upstream/fork patch:

- `src/hub/hub.ts`: Lite mode currently chooses `window.location.hostname`.
- `src/hub/dataSources/nt4/NT4.ts`: `connectOnAlive()` currently probes `http://<host>:<port>`, and `ws_connect()` currently dials `ws://<host>:<port>/nt/<appName>`.
- Patch both paths to accept an injected endpoint object, preferably from postMessage after iframe load or from query params for dev.

Fork maintenance plan:

- Keep the patch as a small source-level patch, not a minified bundle replacement.
- Rebuild with `npm run build:ascope`, then run the NT4 smoke test after every AdvantageScope submodule bump.
- If upstream accepts endpoint injection, drop the fork and keep only router config.

## Q2: Resource cost at N concurrent users

Command used:

```bash
npm run spike:multi -- up
npm run spike:multi -- stats
docker stats --no-stream --format 'json' ...
```

Startup/build spike, shortly after starting 3 sim + 3 LSP containers:

| Container type | Observed CPU | Observed memory |
| --- | ---: | ---: |
| Sim during Gradle startup | 179-192% each | 487-658 MiB each |
| LSP bridge before a client connects | <1% each | 61-73 MiB each |

Steady sim sample after all three reached NT4:

| Container | Max CPU % | Max memory MiB |
| --- | ---: | ---: |
| frc-spike-sim-alice | 2.14 | 781.6 |
| frc-spike-sim-bob | 3.10 | 687.3 |
| frc-spike-sim-charlie | 3.80 | 654.0 |

After opening JDT LS sessions for Alice and Bob:

| Container | CPU % | Memory |
| --- | ---: | ---: |
| frc-spike-lsp-alice | 0.26 | 695 MiB |
| frc-spike-lsp-bob | 0.15 | 450 MiB |
| frc-spike-lsp-charlie, no active client | 0.09 | 70 MiB |
| sim containers, steady | 0.8-3.4 | 671-735 MiB |

Extrapolation to 10 active students:

- Sim: roughly 7-8.5 GiB.
- Active JDT LS: roughly 4.5-7 GiB.
- Total containers: roughly 12-15.5 GiB before Docker/OS/browser overhead.
- CPU risk is not steady-state sim; it is synchronized Gradle builds. Three simultaneous sim startups used about 5-6 CPU cores worth of burst. V1 should queue or rate-limit Run/build per host if the teaching workflow causes everyone to click Run at once.

## Q3: JDT LS topology - per-user or shared

Recommendation: **per-user JDT LS for V1**.

Per-user LSP containers worked as expected at the connection/diagnostic level:

```text
alice: websocket open=true, initialized=true, diagnostics=0
bob:   websocket open=true, initialized=true, diagnostics=0
```

Completion requests in the quick scripted smoke returned no labels, even though prior manual MVP verification showed browser completions working. I would not treat the scripted completion miss as a topology blocker; it is likely a request-position/timing issue in the smoke client.

Shared-process test:

- Created `/workspace/users/alice/project` and `/workspace/users/bob/project` in one LSP container.
- Opened one WebSocket, initialized one JDT LS process with both folders.
- Opened Alice with valid text and Bob with a deliberate syntax break.

Observed result:

```text
open=true, initialized=true
diagnostics:
  file:///workspace/users/alice/project/src/main/java/frc/robot/Robot.java -> 7
  bob broken buffer -> no diagnostic notification observed
```

That is not clean enough to build V1 around. A truly shared JDT LS would also require a browser-session broker/multiplexer so multiple Monaco clients can safely share one LSP process. That broker is probably more work and risk than the memory saved for a 10-student first version.

## Q4: Session identity and backend routing

Spike choice: **query param** (`?user=alice`) because it was the smallest thing that unblocked experiments.

Evidence:

```text
GET /file?user=alice -> 200
GET /file?user=bob   -> 200
POST /file?user=bob  -> 204
Alice changed? false
Bob has marker? true
Alice has marker? false
Bob restored? true
```

V1 recommendation: use a path prefix at the public router, probably `/u/<session>/...`, and have the router set/validate a cookie later when auth exists. Query params are fine for local dev but awkward for WebSocket routing, iframe URLs, logs, and bookmarks once real sessions exist.

## Q5: Container lifecycle latency

Warm Run through the backend:

```text
status building at 1 ms
status running at 7235 ms
```

Cold sim lifecycle:

```text
sim container created in 0.29s
NT4 readiness observed in 10.32s
```

Cold LSP lifecycle:

```text
LSP container created in 0.27s
bridge listening in 0.96s
initialize response in 2.92s
```

Interpretation:

- Sim cold start is tolerable for a first V1, but a pre-warmed sim pool of 1-2 sessions would make class-start feel better.
- LSP container start is cheap because the image is already built and Gradle/WPILib are pre-warmed. First useful completion may still need more browser-level verification than this spike did.
- The larger lifecycle risk is synchronized builds consuming CPU, not raw Docker start time.

## Follow-up risks deferred to V1

- Replace the generated-bundle AS Lite patch with a source-level patch or upstreamable endpoint injection.
- Decide whether AS Lite endpoint config is query params, postMessage, or a tiny bootstrap script. PostMessage is cleaner for hiding internal route details from the iframe URL.
- Add a real router service that handles HTTP, WebSocket upgrades, AS Lite hosting/proxying, backend routing, and LSP routing from one session map.
- Add host-level Run/build concurrency limits.
- Add container cleanup, idle timeout, and project persistence semantics.
- Re-test JDT LS completions through the actual browser for 2-3 simultaneous students; the smoke client verified initialization/diagnostics, not rich editor UX.
- Measure on the real target host with the expected CPU/RAM, not just the development desktop.
