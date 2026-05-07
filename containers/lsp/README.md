# V1 LSP container

Per-workspace Eclipse JDT LS image plus a Bun-native WebSocket bridge.

The image bundles:

- Eclipse Temurin 17 JDK
- Eclipse JDT Language Server
- Bun runtime (used for the WebSocket bridge in `bridge/bridge.ts`)
- A Gradle/WPILib cache primed from `templates/wpilib-java-command/` so the first project load does not re-download dependencies

At runtime the control plane mounts:

- `data/users/<workspaceId>/project` -> `/workspace/project` (student source of truth)
- `data/users/<workspaceId>/jdtls-data` -> `/workspace/jdtls-data` (JDT LS index/state, regenerable)
- `data/users/<workspaceId>/home` -> `/home/frc` (Gradle/JDK cache, regenerable)

The container exposes container port `30003` for the bridge `/jdtls` WebSocket. The control plane proxies this through `/u/:workspaceSlug/ws/lsp` so per-user host ports are never exposed to the browser.

A new JDT LS subprocess is spawned for every WebSocket connection. The bridge translates per-frame JSON-RPC messages into stdio LSP framing (`Content-Length: N\r\n\r\n<json>`) and back.

Build the V1 LSP image with `bun run docker:build:lsp`.
