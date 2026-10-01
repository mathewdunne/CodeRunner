---
sidebar_position: 3
title: FAQ
---

# FAQ

### What hardware do I need for my team?

Each active student workspace can use up to 4 GB of RAM at the default `CODE_MEMORY_LIMIT=4096m` (idle editors use much less). The server-side reference sizing (from `.env.example`) is:

- **3–5 students:** 16 GB RAM, 4+ CPU cores
- **6–10 students:** 32 GB RAM, 6+ cores
- **10+ students:** 48+ GB RAM, 8+ cores

These are simultaneous-use numbers: if only half your team codes at once, you can size down accordingly. See [Capacity planning](../operating/capacity.md) for monitoring guidance and tuning tips.

### Can CodeRunner run offline or without internet?

After initial setup it mostly can. The bundled lesson catalog (baked into the workspace Docker image at `/opt/frc-catalog`) and the Gradle/WPILib dependency cache (primed during the image build) are all local, so students can open lessons, edit code, and run simulations without any network access.

What does require internet: pulling the control and workspace Docker images for the first time (the first `docker compose pull`/`up` downloads several gigabytes), and OAuth sign-in. GitHub and Google OAuth redirect students to external servers to authenticate, so login does not work without internet. For a fully offline evaluation you can use demo mode (`--demo`), which bypasses authentication entirely.

### Can students accidentally break each other's work?

No. Each student gets an isolated workspace container with their own VSCodium instance and file system. Containers are namespaced; students cannot see or modify each other's files. The control plane routes each authenticated user only to their own container.

### Can students push code to GitHub?

Yes, if they are working on a team-imported project. When a student uses the **Switch Project** surface to import a repository from a GitHub team, the workspace retains the `.git` directory and the student can push changes using the VS Code source control panel or the `gh` CLI bundled in the container. Bundled catalog lessons do not have a Git remote attached.

### Where does PathPlanner save changes?

PathPlanner writes to `src/main/deploy/pathplanner/` in the current project.
Those files appear in VSCodium and can be committed normally. Choreo files under
`src/main/deploy/choreo/` are visible in PathPlanner but read-only there. This is
the same behavior as the desktop PathPlanner app.

### What WPILib and Java version does CodeRunner use?

The bundled robot starter uses **GradleRIO 2026.2.1** and Temurin **17.0.15**
for Gradle, project compilation, and simulation. The editor includes the
**wpilibsuite.vscode-wpilib 2026.1.1** extension. Students do not need Java or
VS Code installed on their own devices.

### Can I build or start simulation from the WPILib extension?

You can use the extension's build commands. Its simulation command should also
work technically, but you should not use it in CodeRunner. Start simulations
with **Start** in the Driver Station so CodeRunner uses its supported headless
simulation path and connects the controls and telemetry. When robot code and
communications are ready, choose a mode and click **Enable**.

### Do students need accounts? What if I just want to try it?

Students can sign in with GitHub or Google if their email is on the operator's
allowlist. For a short classroom session, an admin can share a code so students
can join with just a name. Guest accounts and projects are deleted when the
classroom ends.

For a solo evaluation or demo, start the demo stack (`CODERUNNER_DEMO_MODE=1 docker compose up`, or `bun run demo:docker`). Demo mode bypasses all authentication. See [Quick Start (Installation)](../quick-start.md).

### What happens to a student's work when they switch lessons?

Switching to a different lesson or resetting a project intentionally discards the current workspace contents. This is by design: the lesson catalog is a learning tool, not a long-term storage model. For team projects where students need to preserve history, they should use a GitHub team import (which keeps `.git` and can push to the remote). For bundled lessons, the expectation is that completed exercises are pushed somewhere before switching. See [Lessons overview](../lessons/overview.md) for the full project-lifecycle explanation.

### Is a Chromebook sufficient for students?

Yes. All computation (Java compilation, Gradle builds, the WPILib simulator, and the VSCodium editor) runs inside Docker containers on the CodeRunner server. The browser receives a proxied editor session over HTTP. A Chromebook, tablet with a keyboard, or any device with a modern browser is sufficient. No local Java or VS Code installation is required on the student's device.

### Can I write my own lessons?

Yes. Lessons are Gradle WPILib projects with a small metadata file. You can author them in the bundled `catalog/` directory (rebuilt into the image) or in a separate public GitHub repository pointed to by `LESSONS_CATALOG_REPO`. The remote-repo option lets you iterate on lesson content without rebuilding the Docker image. See [Authoring modules](../lessons/authoring-modules.md) for structure and tooling details.

### How much does cloud hosting cost?

The reference deployment uses a `c4-standard-4` VM (4 vCPU, 15 GB RAM) on Google Cloud with a 50 GB Hyperdisk data disk and daily snapshots. At us-central1 on-demand pricing that is roughly **$120–150/month** for the VM alone, plus a small amount for disk and snapshot storage. Grafana Cloud's free tier covers metrics and logs for a small deployment. Running the VM only during build season (a few months) and using the [seasonal teardown](../deploying/gcloud.md) procedure to snapshot and delete resources between seasons can bring the annual total well under $300. These are rough estimates; actual cost depends on region, committed-use discounts, and bandwidth.

### Why is the first build or run slow?

Two separate warm-up steps happen on first use:

1. **Docker image pull.** The first `docker compose pull` (or `up`) downloads `ghcr.io/mathewdunne/coderunner-workspace:latest`, which is several gigabytes (it bundles Java runtimes, WPILib, and VS Code). This only happens once per machine; subsequent starts reuse Docker's cached layers.

2. **Gradle cache warm-up.** The workspace image primes the Gradle and WPILib dependency cache during its build by running a full `./gradlew build` against the bundled `robot-starter` module. This cache is stored at `/opt/frc-gradle-cache` inside the image and copied into each student's container on first start. Despite this priming, the very first build in a fresh container still runs the Java language server index and compiles the project from scratch. After that first run, incremental builds are much faster.
