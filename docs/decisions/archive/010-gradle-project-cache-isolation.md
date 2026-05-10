# 010 - Gradle project cache isolation for sim and LSP

**Status:** Implemented (V1-10 bug fix)  
**Date:** 2026-05-09

## Context

The V1-10 three-user smoke exposed a Gradle lock conflict during the LSP phase.
Each workspace has separate sim and LSP containers and already uses separate
`GRADLE_USER_HOME` directories, but both containers mount the same project at
`/workspace/project`. Gradle still defaults its project-specific cache to
`/workspace/project/.gradle`, so a live `simulateJava` run can hold
`.gradle/8.11/fileHashes/fileHashes.lock` while JDT LS imports the project.

That surfaced as Buildship/JDT LS timing out on the file-hash cache and never
publishing diagnostics.

## Decisions

- Sim runs now pass `--project-cache-dir "$HOME/.gradle-project-sim"` to Gradle.
  This keeps the long-lived sim Gradle process away from the shared
  `project/.gradle` cache that JDT LS uses during import.
- Run cancellation now executes `/usr/local/bin/stop-sim.sh` in the sim
  container before terminating the host-side `docker exec` wrapper. Docker does
  not reliably propagate a signal sent to the host wrapper into the exec'd shell,
  so the previous trap-based stop path could leave `simulateJava` running.
- The three-user smoke waits for run `stopped` statuses before beginning LSP
  diagnostics. That makes the validation fail on stop regressions instead of
  racing into the next phase.

## Implications

`data/users/<workspaceId>/project` remains the authoritative student project and
continues to hide `.gradle/**` from the file API. The new sim project cache lives
under `data/users/<workspaceId>/home/`, which is regenerable tooling state and
safe to prune when containers are stopped.
