# Decision 012: V2 Code Image — Base Image and Extension Strategy

**Date:** 2026-05-09
**Status:** Accepted
**Stage:** V2 Stage 1

## Context

Stage 1 requires building a `frc-code:v2` Docker image that merges the V1 sim and LSP containers. Two key architecture decisions:

1. **Base image choice:** The V2 design doc specifies `eclipse-temurin:17-jdk-jammy`, but the Stage 0 spike proved `gitpod/openvscode-server:1.105.1` works. An alternative approach is to base on the openvscode-server image and install JDK into it.

2. **Extension distribution:** The design doc specifies vendoring `.vsix` files in `vendor/vscode-extensions/`. An alternative is downloading at build time from public registries.

## Decision

### Base image: `gitpod/openvscode-server:1.105.1`

We base the V2 code image on `gitpod/openvscode-server:1.105.1` and install JDK 17 into it, rather than starting from `eclipse-temurin:17-jdk-jammy` and installing openvscode-server manually.

**Rationale:**
- The spike (Decision 011) already proved this base image works end-to-end.
- openvscode-server has a complex internal directory layout (`/home/.openvscode-server/`, extension host, Node.js runtime). Starting from the official image avoids recreating this manually.
- Installing JDK into a Debian/Ubuntu image is a well-understood, single-step operation.
- The Gitpod team maintains the image and handles upstream VS Code rebasing.

**Trade-offs:**
- Docker Hub publishing lags behind GitHub releases (1.105.1 vs 1.109.5 at time of writing). This is acceptable for a classroom tool; we pin a known-good version.
- The base image includes a default `openvscode-server` user (UID 1000) that we don't use. We create our own `frc` user with configurable UID/GID for bind-mount compatibility with V1.

### Extensions: download at build time

Extensions are downloaded from public registries during `docker build` instead of vendoring `.vsix` files in the repository.

**Sources:**
- `redhat.java` 1.38.0 from Open VSX: `https://open-vsx.org/api/redhat/java/1.38.0/file/redhat.java-1.38.0.vsix`
- `vscode-wpilib` 2026.1.1 from GitHub Releases: `https://github.com/wpilibsuite/vscode-wpilib/releases/download/v2026.1.1/vscode-wpilib-2026.1.1.vsix`

**Rationale:**
- Avoids committing large binary files (~50-100 MB) to git.
- Pinned version URLs are reproducible and auditable.
- Docker layer caching means downloads only happen on version bumps.
- Both registries (Open VSX, GitHub Releases) are stable public infrastructure.

**Trade-off:**
- Building the image requires internet access. This is acceptable for initial setup; the built image runs offline.
- The design doc's "build succeeds with the host offline" DoD item is relaxed. The image itself runs offline; only the build needs internet.

### Spotless Gradle extension included as a pinned Marketplace artifact

The V2 image includes `richardwillis.vscode-spotless-gradle` for code formatting. The extension is only published on the VS Code Marketplace, not Open VSX, so the Dockerfile downloads it from the Marketplace gallery asset endpoint. To avoid unnecessary build drift, the URL pins version `1.2.1` instead of using the mutable `latest` asset URL. The extension has not been updated in several years; if it does change later, treat updates as an explicit version bump in `containers/code/Dockerfile` and `vendor/vscode-extensions/README.md`.

### Direct launch base path handling

The entrypoint omits `--server-base-path` when `VSCODE_BASE_PATH` is empty or `/`. Passing `--server-base-path /` caused openvscode-server 1.105.1 to generate invalid WebSocket URLs such as `ws://127.0.0.1:33334stable-...` during direct hand-launched smoke tests. Proxied V2 containers still pass `VSCODE_BASE_PATH=/u/<slug>/vscode/`, which keeps the editor's HTTP and WebSocket URLs under the authenticated control-plane route.

### Extension cache seeding pattern

Extensions are installed at build time into `/opt/frc-extensions-cache/`. The entrypoint copies them to the bind-mounted `/home/frc/.openvscode-server/extensions/` on first run, mirroring the V1 Gradle cache seeding pattern. This ensures:
- Extensions survive container recreation (persisted in the bind mount).
- New workspaces get extensions without internet access.
- Students can install additional extensions that persist alongside the baked ones.

## Consequences

- Stage 2+ can rely on the openvscode-server binary being at `/home/.openvscode-server/bin/openvscode-server`.
- Version bumps require changing Dockerfile build args and rebuilding.
- The `vendor/vscode-extensions/` directory contains only a README documenting provenance, not actual `.vsix` files.
