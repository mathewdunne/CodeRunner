# 035 — Multi-Arch Images and CI/Release/Deploy Workflow Split

## Status

Accepted.

## Context

A user asked for arm64 support so the demo and self-hosted stack run natively
on Apple Silicon. Both GHCR images were amd64-only, and everything — verify,
image publish, GCE/Cloudflare deploy — lived in one `workflow_dispatch`
pipeline (`deploy.yml`), so tests only ran at deploy time and publishing arm64
images for the community would have meant touching prod.

Arch audit findings that shaped the design:

- `emscripten/emsdk:4.0.12` publishes **no arm64 image**. Every other base
  image (`oven/bun`, `docker:*-cli`, `linuxserver/openvscode-server`) is
  multi-arch. The AdvantageScope wasm/JS output itself is
  architecture-independent.
- WPILib 2026.2.1 (including `halsim_ws_server`), AdvantageKit 26.0.2, and
  WPILibNewCommands all publish `linuxarm64` natives, so the workspace image's
  Gradle cache-priming build doubles as a build-time gate: missing natives fail
  the image build, not a student session.
- The only x64 hardcode in the repo was the Temurin JDK download URL in the
  workspace Dockerfile.
- The baked `redhat.java` VSIX is the universal build (no embedded JRE);
  runtime gallery updates resolve per-platform on their own.
- The workspace image runs a full Gradle/JVM build in a `RUN` layer, which
  rules out QEMU-emulated multi-arch builds (10–20× slower, JIT flakiness).
  The repo is public, so GitHub's native arm64 runners (`ubuntu-24.04-arm`)
  are free.

## Decision

**Three workflows instead of one:**

- `ci.yml` — `bun run verify` on PRs and pushes to `main` (tests now run
  before release time).
- `release.yml` — triggered by pushing a `v*` tag: validates semver format and
  checks `main` ancestry to classify the release, runs
  verify, publishes multi-arch images, and uploads the
  `web-dist`/`ascope-dist` tarballs to the GitHub release.
  Tags outside `main` automatically become GitHub prereleases, even without a
  version suffix, so fixes can be tested before merging. Tags with prerelease
  suffixes (for example `v0.6.1-selinux-fix`) remain prereleases on any branch.
  Classification uses commit ancestry at workflow execution time because tags
  do not store a source branch. Prereleases publish versioned images and a
  GitHub prerelease with `--latest=false`; only stable tags update image `latest`.
  Release creation uses `--verify-tag` with the existing pushed tag and omits
  `--target`: explicitly targeting a commit that changes workflows relative to
  `main` can require workflow-write permission unavailable to `GITHUB_TOKEN`.
- `deploy.yml` — stays a manual `workflow_dispatch` with a tag input, but only
  *consumes* a published release: a preflight job checks the release and both
  multi-arch manifests exist, then the unchanged GCE + Cloudflare jobs roll it
  out. Redeploying an old tag no longer rebuilds anything.

**Multi-arch via native runners + digest merge** (the pattern from Docker's
"multi-platform images with GitHub Actions" docs): each arch builds on its
native runner (`ubuntu-latest` / `ubuntu-24.04-arm`) and pushes by digest
(`push-by-digest=true`, no tags); a merge job stitches the digests into one
manifest list per image with `docker buildx imagetools create`, applying the
the version tag and, for stable releases, `:latest` there. Consumers are untouched — the amd64 GCE VM
and arm64 laptops pull the same tag and get their own arch. GHA build caches
are scoped per image × arch (`workspace-arm64`, `control-amd64`, …).

**The emsdk stage builds once, on amd64.** The control Dockerfile gained a
filesystem-only `ascope-dist` stage that downstream stages copy from. The
arm64 CI build passes `build-contexts: ascope-dist=<dir>` pointing at the
amd64 job's `dist-export` harvest, which substitutes the stage and skips emsdk
entirely — valid because the wasm/JS output is architecture-independent. Local
and amd64 builds are unaffected (the stage chain still builds emsdk normally).

**The workspace JDK URL derives from `TARGETARCH`** (`x64` / `aarch64`
Temurin classifiers), keeping `JDK_VERSION` as the single pin.

## Consequences

- Pushing a semver tag on `main` publishes everything; deploying is a separate
  button. Tests gate merges, not just releases.
- Apple Silicon users get native images for both `coderunner-control` and
  `coderunner-workspace` from the same tags; no Rosetta emulation of the JVM.
- A local **control**-image build on an arm64 machine still hits the
  emsdk-has-no-arm64 wall: it needs QEMU for that one stage, or
  `--build-context ascope-dist=<prebuilt dist>` (e.g. from
  `scripts/fetch-dist.ts` output). Accepted — CI images are the deliverable,
  and the local workspace-image build works natively on arm64.
- Four GHA cache scopes share the repo's 10 GB cache; if cold builds get
  frequent, moving to `type=registry` cache is the escape hatch.
- The arm64 control build depends on the amd64 control build finishing (for
  the ascope dist), serializing that one pair; workspace builds stay fully
  parallel.
