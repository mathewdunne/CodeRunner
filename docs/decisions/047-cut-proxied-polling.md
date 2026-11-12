# 047 — Cut proxied polling: push sim status over the run socket

## Context

With the optional Cloudflare front end (`docs/deploying/cloudflare.md`),
every backend request goes through the Pages Function catch-all. The Workers
free plan allows 100,000 function requests a day. A WebSocket counts once, at
the upgrade. Frames on an open socket are not counted.

On 2026-11-11, a meeting with up to 7 workspaces used ~91k requests between
23:00 and 04:00 UTC (~47k in the peak hour), and Cloudflare sent its
"90% of daily limit" email. The control plane's route metrics broke that down:

| Route | Requests | Source |
| --- | --- | --- |
| `GET /u/:slug/sim/alive` | 42.6k | AS Lite NT4 alive probe, every 350 ms until a robot answers |
| `GET /u/:slug/api/sim/status` | 20.8k | `useSimulationState`, 1 s poll |
| `GET /u/:slug/api/sim/auto-choosers` | 20.7k | `useAutoChoosers`, 1 s poll |
| `GET /u/:slug/vscode/*` | 2.8k | editor loads |
| everything else | ~2k | heartbeat, sockets, auth, Preview, … |

An open workspace tab cost about 5 requests/second, so 100k/day covered
roughly 6 student-hours. Static assets were negligible.

## Decision

1. **Sim status and auto choosers are pushed over `/ws/run`.** When a run
   socket opens, the control plane starts a 1 s server-side timer. Each tick
   runs the same `simStatusSnapshot` and `autoChoosersSnapshot` code as the
   HTTP routes, bridge (re)connect side effects included. It sends
   `{type:"sim-status"}` / `{type:"auto-choosers"}` (or `status: null` on
   error) only when the snapshot's JSON differs from the last one sent on
   that socket. `useRunChannel` exposes both. It resets them to `null` when
   the socket drops, as a failed poll did. `useSimulationState` and
   `useAutoChoosers` take the pushed value instead of polling. Commands
   still refresh over HTTP so their result shows immediately. The HTTP GET
   routes stay for that, for tests, and for other clients.
2. **The AS Lite alive probe retries every 1 s, not 350 ms**, when the
   endpoint is injected by our shell (`patches/advantagescope/001`).
   Standalone AdvantageScope keeps the upstream 350 ms. Telemetry can appear
   up to ~1 s later after a robot starts, which is small next to robot
   startup time.

Per tab, traffic drops from ~5 requests/s to ~1/s while no robot is running
(the alive probe) and to near zero while one is connected.

## Rejected

- **Caching at the edge.** Every request invokes the function before any
  cache lookup, and these responses are per-user.
- **Sending API/WebSocket traffic straight to `origin.`, bypassing the
  function.** The shell and backend would be different origins. That needs
  cookie `Domain=` sharing, credentialed CORS on every route, CSRF rework,
  and cross-origin editor/`/scope/`/Preview frames and `postMessage` checks.
  That is too much security surface for a polling problem.
- **Excluding static assets with `_routes.json`.** They were ~1% of traffic.
- **A held-open (long-poll) `alive` request or a shell→AS "probe now"
  nudge.** Either would cut the remaining alive traffic further, but both
  need more patch and server code than a best-effort fix warrants. Revisit
  if the alive probe becomes the budget problem.

## Consequences

- The server reads both snapshots once a second per open run socket,
  including hidden tabs (browsers used to throttle the hidden-tab polls).
  This is local work on the VM. The idle sweep is unaffected: it keys off
  the 60 s heartbeat, which already ran in hidden tabs.
- While a robot runs, `sim-status` changes most ticks (HALSim
  `lastMessageAt`), so it is pushed about once a second. These are free
  WebSocket frames.
- If a command's HTTP refresh differs from the last pushed snapshot and the
  server state then reverts to that snapshot, the client keeps the HTTP
  value until the next real change. This is accepted as rare.
