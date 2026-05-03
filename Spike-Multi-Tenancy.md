# Multi-Tenancy Spike

## Context

The MVP (`Project-MVP.md`) proves the per-user inner loop end-to-end: edit, build, run, watch telemetry. The eventual system targets ~10 concurrent students sharing one host, with isolated per-student environments and a session router for WebSocket traffic. None of that is exercised by the MVP.

Before starting the V1 rewrite, this spike answers the architectural questions that, if discovered late, would force a second rewrite. Output is evidence and a recommended V1 architecture, not shipped code.

## Goals

Answer the five questions below with concrete evidence (numbers, working prototypes, or "we tried X, hit Y, recommend Z"). Land a findings doc that recommends a V1 architecture for container topology, NT4 routing, session identity, and JDT LS sharing.

## Non-goals

- Auth, project ownership, persistence across sessions
- Polished UX or a real router design
- Production-quality code — spike code may be discarded
- Stop/restart buttons, project picker, multi-file editing
- Anything that lasts past the spike unless it organically becomes part of V1

## Key questions

### Q1: NT4 routing under multi-tenancy

Biggest unknown. AS Lite hardcodes `window.location.hostname` and `5810` for NT4 (see `docs/decisions/002-advantagescope-lite-hosting.md`). That worked for one student. With many, options are:

- (a) Port-per-user — all students hit the same host on different ports
- (b) Subdomain-per-user — `alice.sim.host:5810` (forces TLS cert and DNS work)
- (c) WS proxy demuxing by path — `ws://host/sim/alice/nt4` (requires AS Lite source patch; an AS fork is acceptable)
- (d) Patch AS Lite to read endpoint from URL param / postMessage

Pick one. Document what source patches are required, deployment-model implications, and how the fork is maintained against upstream.

### Q2: Resource cost at N concurrent users

Stand up 3 students worth of containers (3 sim + 3 LSP, or 3 sim + 1 shared LSP if Q3 says shared works). Measure on the target host:

- Idle RAM/CPU per student
- Cost during a Gradle build (heap-heavy, CPU-heavy)
- Cost during steady-state simulation
- Spin-up and tear-down latency for a fresh per-user environment

Extrapolate to 10. If JDT LS is the bottleneck (each instance easily 1.5 GB resident), Q3 becomes load-bearing.

### Q3: JDT LS topology — per-user or shared

Eclipse JDT LS supports multiple workspaces in one process. Test:

- Can one `frc-lsp` container handle 2–3 student workspaces concurrently with correct LSP routing per browser?
- Does diagnostics or completion latency degrade noticeably?
- Failure isolation — if one workspace's project is broken, does it take down the others?

A working shared JDT LS dramatically changes the V1 resource model. A broken one means container-per-student, full stop.

### Q4: Session identity and backend routing

Pre-auth, how does the backend know which sim and LSP belong to which browser session? Smallest viable option:

- URL path baked into the dev URL (`/u/alice/...`)
- Query param (`?user=alice`)
- Cookie set by a one-screen "pick a username" flow

Pick the smallest thing that unblocks the other experiments. This is the seed of V1 auth, not the answer to it.

### Q5: Container lifecycle latency

Cold-start cost vs. pre-warmed pool. From the moment a student "logs in":

- How long until LSP completion works?
- How long until Run produces a sim with NT4?

Compare on-demand spin-up to a small pre-warmed pool. The answer changes the orchestrator design materially.

## Experiments

Run in order. Each produces evidence for the findings doc.

1. **Two-user hardcoded spike.** Modify the dev stack to run `frc-sim-alice` + `frc-lsp-alice` and `frc-sim-bob` + `frc-lsp-bob` simultaneously. Two browser tabs at `?user=alice` and `?user=bob`. Each shows independent sim data in AS Lite, independent file save, independent LSP diagnostics. No real router yet — just prove coexistence.

2. **NT4 routing experiment.** Implement option (c) end-to-end: a small WS proxy that demuxes `/sim/<user>/nt4` to the right container. Apply the minimal AS Lite source patch to read the path; fork is acceptable. Document the diff and the fork-maintenance plan.

3. **Resource measurement.** With 3 of each running, capture `docker stats` over a 5-minute window covering idle, build, and steady-state sim. Record memory high-watermarks and total host load. Extrapolate to 10.

4. **Shared JDT LS test.** Configure one JDT LS process with two project roots. Confirm Monaco diagnostics, hover, and completion still work for both buffers without cross-contamination. Try breaking one project and confirm the other survives.

5. **Lifecycle timing.** Cold-start a fresh sim + LSP container pair; time from request to working LSP completion and to a running sim. Compare to a pre-warmed pool of one of each.

## Definition of done

`docs/decisions/006-multi-tenancy-findings.md` exists and contains:

- An answer to each of Q1–Q5 with supporting evidence (numbers, log excerpts, or a clear "we tried X, hit Y, recommend Z").
- A recommended V1 architecture covering: container topology (per-user vs. shared per service), NT4 routing approach, session identity mechanism, and JDT LS sharing model.
- A list of follow-up risks deferred to V1 implementation.

Spike code does not need to be merged. The findings document is the deliverable.

## Time box

3 days of focused work. If a question cannot be answered in that window, the findings doc records "tried X, hit Y, recommend further investigation Z" rather than the spike extending. Q1 (NT4 routing) and Q3 (shared vs. per-user JDT LS) are the load-bearing questions; if time gets tight, prioritize them over Q2/Q4/Q5.
