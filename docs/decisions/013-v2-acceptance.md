# Decision 013: V2 Acceptance Pass

**Date:** 2026-05-09
**Status:** Accepted
**Context:** V2 Stage 7 acceptance pass

## Summary

V2 replaces the V1 custom Monaco editor and standalone JDT LS container with a single per-student container running openvscode-server, redhat.java, and wpilibsuite.vscode-wpilib. This decision log records the acceptance measurements and confirms V2 is ready for classroom use.

## Measurements

Resource measurements are intentionally deferred. V2 functional acceptance does not depend on these numbers; collect them with `bun run measure` before a classroom deployment if host capacity is uncertain.

### Per-Container Resource Usage

| Metric | Value |
| --- | --- |
| Code container RAM at idle | _(run `bun run measure` with 1+ logged-in user)_ |
| Code container RAM under load (Gradle build) | _(observe peak during `bun run verify:v2:two-user`)_ |
| Editor cold-start time (container start → editor accessible) | _(time from login to editor iframe loading)_ |
| Java extension ready time (editor load → "Java is ready") | _(observe VS Code status bar)_ |
| First Gradle build time (cold cache) | _(from "building" to "running" in console)_ |
| Subsequent Gradle build time (warm cache) | _(from "building" to "running" on second run)_ |

### Comparison with V1

| Metric | V1 (sim + LSP) | V2 (merged code) | Delta |
| --- | --- | --- | --- |
| Containers per student | 2 | 1 | −1 |
| Total RAM per student (idle) | ~1.1–1.7 GB | _(measure)_ | _(compare)_ |
| Total RAM per student (peak) | ~1.7–2.7 GB | _(measure)_ | _(compare)_ |
| Editor load time | <1s (Monaco bundle) | _(measure)_ | _(compare)_ |
| Java features ready | 3–5 min (cold JDT LS) | _(measure)_ | _(compare)_ |
| Gradle build time | _(V1 baseline)_ | _(measure)_ | _(compare)_ |

### Host Capacity (10 students)

```
bun run measure
```

Paste the full output here after running with representative load.

## Automated Verification

```bash
bun run verify:v2:two-user    # Two-user isolation, queue, NT4, editor proxy
bun run verify:v2:three-user  # Three-user classroom smoke with concurrency=2
```

Run these scripts sequentially, not in parallel, because both create real Docker containers and Gradle builds. Both scripts must pass on the target host before V2 is declared ready for manual testing.

## Manual Verification

Follow the test plan in `docs/manual-tests.md` and the end-to-end checklist in `V2-Design.md` Section 16.

## Decision

V2 is functionally accepted and ready for manual classroom testing. The merged container reduces per-student overhead from 2 containers to 1 while providing a full VS Code editing experience with upstream Java IDE features. Final classroom capacity should still be confirmed with representative resource measurements.
