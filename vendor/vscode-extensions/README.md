# Vendored VS Code Extensions

This directory documents the VS Code extensions bundled into the V2 code container image. Extensions are **downloaded at build time** from public registries — no `.vsix` files are stored in this directory.

## Bundled Extensions

### Core (from Stage 0 spike)

| Extension | Version | Source |
|---|---|---|
| redhat.java (Language Support for Java) | 1.38.0 | [Open VSX](https://open-vsx.org/api/redhat/java/1.38.0/file/redhat.java-1.38.0.vsix) |
| wpilibsuite.vscode-wpilib (WPILib) | 2026.1.1 | [GitHub Releases](https://github.com/wpilibsuite/vscode-wpilib/releases/download/v2026.1.1/vscode-wpilib-2026.1.1.vsix) |

### Java Extension Pack (meta-pack + individual extensions)

| Extension | Version | Source |
|---|---|---|
| vscjava.vscode-java-pack (Extension Pack for Java) | 0.30.5 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-java-pack/0.30.5) |
| vscjava.vscode-java-debug (Debugger for Java) | 0.59.0 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-java-debug/0.59.0) |
| vscjava.vscode-java-test (Test Runner for Java) | 0.45.0 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-java-test/0.45.0) |
| vscjava.vscode-maven (Maven for Java) | 0.45.3 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-maven/0.45.3) |
| vscjava.vscode-gradle (Gradle for Java) | 3.17.3 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-gradle/3.17.3) |
| vscjava.vscode-java-dependency (Project Manager for Java) | 0.27.2 | [Open VSX](https://open-vsx.org/api/vscjava/vscode-java-dependency/0.27.2) |

### Code formatting

| Extension | Version | Source |
|---|---|---|
| richardwillis.vscode-spotless-gradle (Spotless Gradle) | latest | [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=richardwillis.vscode-spotless-gradle) |

## Provenance

- **redhat.java 1.38.0**: Published by Red Hat on Open VSX. Same upstream version bundled by WPILib 2026. Verified in Stage 0 spike (Decision 011).

- **vscode-wpilib 2026.1.1**: Published by wpilibsuite on GitHub Releases. WPILib Kickoff release for the 2026 season. Pure JS/TS extension. Verified in Stage 0 spike (Decision 011).

- **Java Extension Pack + sub-extensions**: Published by Microsoft/vscjava on Open VSX. The pack is a meta-extension that declares `extensionPack` dependencies. We install both the pack and all its sub-extensions explicitly to ensure they are available offline.

- **Spotless Gradle**: Published by Richard Willis on the VS Code Marketplace only (not on Open VSX). Downloaded from the marketplace gallery asset API at build time. This extension integrates the Spotless code formatter with the Gradle build system.

## Version Pinning

Extension versions are pinned as Docker build args in `containers/code/Dockerfile`. To update:

1. Change the build arg default in the Dockerfile.
2. Rebuild: `bun run docker:build:code`
3. Test auto-import and ctrl-click in the rebuilt container.
4. Update this README and add a decision log if the version jump is non-trivial.

## Why Not Vendor .vsix Files?

- `.vsix` files are large binaries (~50-100 MB for redhat.java) that bloat git history.
- Downloading at build time with pinned version URLs is reproducible and easy to audit.
- Docker layer caching means the download only happens on version bumps.
- Both source registries (Open VSX, GitHub Releases) are stable and reliable.
