#!/usr/bin/env bash
set -euo pipefail

# The LSP container is a "jdtls launchpad". The backend (apps/server) opens
# one jdtls process per browser /lsp WebSocket via `docker exec`, so this
# entrypoint just needs to keep the container alive.
exec sleep infinity
