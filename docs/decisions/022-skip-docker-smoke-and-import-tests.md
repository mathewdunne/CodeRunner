# Decision 022: Skip Docker smoke tier and import/backup-restore E2E tests

## Status
Accepted

## Context

The testing plan (TESTING-PLAN.md) described two categories of tests that we've decided not to implement:

1. **Docker smoke tier (T-D1 through T-D7)**: Tests that exercise the real `frc-code:v2` container image — building, running Gradle, JNI loading, multi-workspace Gradle lock isolation, headless GUI removal, etc.

2. **Import and backup/restore E2E tests**: Tests covering the GitHub project import flow, size limits, rate limits, post-import permissions, and backup/restore functionality.

## Decision

### Docker smoke tier — not implemented

The Docker smoke tier requires:
- A Docker daemon available in the test environment
- The `frc-code:v2` image pre-built (`bun run docker:build:code`)
- Multi-minute timeouts per test (180s default, up to 420s for extension cold start)
- Fixture projects committed for specific edge cases (vendor-JNI, headless-incompatible, broken-build)

The mocked E2E tier and unit tests already cover the logic paths (run lifecycle, timeout handling, state recovery, build failures). The Docker tier would only prove the real runtime boundary works, which is validated manually during development and deployment.

The cost/benefit ratio doesn't justify the infrastructure investment for this project's scale and team size.

### Import and backup/restore tests — deferred

The import flow is being reworked in the near future. Writing tests for the current implementation would be throwaway work. These tests should be written after the rework lands.

## Consequences

- Docker-specific edge cases (GLIBCXX versions, JNI loading, Gradle lock contention) remain manually tested
- Import flow regressions are not automatically caught until the rework + new tests land
- The mocked E2E tier remains the primary integration test surface
