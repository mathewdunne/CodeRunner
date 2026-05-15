# Docker smoke tier

These specs require a running Docker daemon and the prebuilt `frc-code:v2`
image. Run with:

```bash
bun run docker:build:code
bun run e2e:docker
```

Each spec calls `test.skip()` automatically when `DOCKER_E2E=1` is not set,
so they can sit safely in the repo and run only in environments that opt in.

The Docker tier is intentionally small (~7 specs); the goal is to prove that
the real `LocalDockerRuntimeProvider` works end-to-end at the boundaries the
mocked tier can't reach: real Gradle builds, JNI library loading, file
permissions, headless GUI removal, and the timeout-kill path through
`docker exec`.

Anchors:
- T-D1 — commit 18ffcb0 (recursive chown)
- T-D2 — decision 017 (GLIBCXX/JNI)
- T-D3 — commit 766e957 (Gradle lock contention)
- T-D4 — decision 016 (headless GUI removal)
- T-D5 — commit 18ffcb0 (post-import file save)
- T-D6 — decisions 011, 012, 017 (extension cold start)
- T-D7 — runbook §9 (build timeout propagation)
