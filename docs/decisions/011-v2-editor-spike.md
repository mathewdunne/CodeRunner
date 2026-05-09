# Decision 011: V2 Editor Spike — openvscode-server with redhat.java and WPILib

**Date:** 2026-05-09
**Status:** Accepted
**Context:** V2-Design.md Stage 0 spike

## Summary

Proved that openvscode-server with `redhat.java` and `wpilibsuite.vscode-wpilib` extensions delivers a full Java IDE experience for WPILib projects inside a Docker container.

## Versions Pinned

| Component | Version | Source |
|---|---|---|
| openvscode-server (Docker) | `1.105.1` | `gitpod/openvscode-server:1.105.1` on Docker Hub |
| openvscode-server (GitHub release) | `v1.109.5` | Latest GitHub release (not yet on Docker Hub) |
| JDK | Temurin 17.0.15+6 | Adoptium Linux x64 tarball |
| redhat.java | 1.38.0-403 | WPILib 2026 install `vsCodeExtensions/vscode-java-1.38.0-403.vsix` |
| wpilibsuite.vscode-wpilib | 2026.1.1 | WPILib 2026 install `vsCodeExtensions/vscode-wpilib-2026.1.1.vsix` |

## Docker Hub vs GitHub Releases

The latest Docker Hub tag for `gitpod/openvscode-server` is `1.105.1`. The latest GitHub release is `v1.109.5`. Docker Hub publishing appears to lag behind. For the spike, `1.105.1` was used since it is a pinned, available tag. Stage 1 should evaluate whether to switch to downloading the GitHub release tarball and building from a base Ubuntu/Debian image for access to newer versions.

## WPILib JDK Note

The WPILib 2026 install ships Temurin 17.0.16+8, but it is a **Windows x64** build (`OS_NAME="Windows"` in the `release` file). The container requires a Linux JDK, so a separate Temurin 17 Linux x64 tarball is downloaded during image build.

## WPILib Extension Platform Compatibility

The `vscode-wpilib-2026.1.1.vsix` extension contains no platform-specific native binaries (no `.so`, `.dll`, `.node`, or platform-gated directories). It is a pure JS/TS extension and activates successfully on Linux.

The `vscode-java-1.38.0-403.vsix` bundles JDT LS with `config_linux/`, `config_mac/`, `config_win/` directories, so it is cross-platform by design. It installs and activates successfully in the Linux container.

## Spike Results

### Container boots and serves (:3000)

✅ **PASS.** openvscode-server starts and serves the editor UI on port 3000. HTTP 200 returned. Browser opens the full VS Code editor with the project file tree.

### Extensions installed

✅ **PASS.** Both `redhat.java` and `wpilibsuite.vscode-wpilib` are listed by `--list-extensions`.

### Auto-import on Tab (additionalTextEdits)

✅ **PASS.** Verified during the Stage 0 browser spike.

The author manually verified that accepting an unimported WPILib symbol completion in openvscode-server applies the redhat.java `additionalTextEdits` import. Future stages should not spend time re-verifying this extension-owned behavior unless the openvscode-server, `redhat.java`, or WPILib extension versions change.

### Ctrl-click into library source (jdt:// URI)

✅ **PASS.** Verified during the Stage 0 browser spike.

The author manually verified that F12/Ctrl-click on `Pose2d` opens the WPILib class source through redhat.java's `jdt://` content provider.

Future stages should not re-run F12/ctrl-click proof checks for `Pose2d` or other WPILib symbols unless the editor or extension versions change. These checks validate upstream extension behavior, not simulator integration.

## Spike Dockerfile

```dockerfile
FROM gitpod/openvscode-server:1.105.1
# JDK 17 (Temurin Linux x64) installed to /usr/lib/jvm/jdk-17
# JAVA_HOME set, on PATH
# Extensions pre-installed via --install-extension from .vsix files
# ENTRYPOINT: openvscode-server --without-connection-token --host 0.0.0.0 --port 3000
```

Located at `/tmp/frc-spike-openvscode/Dockerfile` (throwaway, per Stage 0 instructions).

## How to Run

```bash
cd /tmp/frc-spike-openvscode
docker build -t frc-spike-openvscode .
docker run -d --name frc-spike \
  -p 3000:3000 \
  -v /mnt/d/Documents/GitHub/2026-RobotCode:/workspace/project \
  frc-spike-openvscode -- /workspace/project

# Open in browser:
#   http://localhost:3000/?folder=/workspace/project

# Cleanup:
docker rm -f frc-spike
```

## Resource Baseline

Idle container (no browser connected): ~35 MB RAM, <3% CPU. Expect significant increase once redhat.java/JDT LS activates on first browser connection (Gradle import, workspace indexing).

## Decisions

1. **Use Docker Hub `gitpod/openvscode-server` base image for the spike.** Simplest path. Stage 1 may switch to tarball-from-GitHub if newer versions are needed.
2. **Download Linux Temurin JDK at build time.** The WPILib-bundled JDK is Windows-only.
3. **Both `.vsix` files come from the WPILib 2026 install directory.** This guarantees version compatibility between redhat.java and the WPILib extension. The redhat.java vsix from WPILib is the universal (non-platform-specific) build.
