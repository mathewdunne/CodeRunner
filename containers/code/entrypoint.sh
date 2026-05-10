#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/frc}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
export SIM_LOG_FILE="${SIM_LOG_FILE:-$HOME/sim.log}"

OPENVSCODE_SERVER_ROOT="${OPENVSCODE_SERVER_ROOT:-/home/.openvscode-server}"
EXTENSIONS_DIR="$HOME/.openvscode-server/extensions"
DATA_DIR="$HOME/.openvscode-server/data"

mkdir -p "$HOME" "$GRADLE_USER_HOME" "$EXTENSIONS_DIR" "$DATA_DIR"

# Seed Gradle cache on first run (same pattern as V1 sim).
if [[ -d /opt/frc-gradle-cache && ! -d "$GRADLE_USER_HOME/caches" ]]; then
  echo "Seeding Gradle cache from image..."
  cp -a /opt/frc-gradle-cache/. "$GRADLE_USER_HOME"/
fi

# Seed extensions on first run (mirroring the Gradle cache pattern).
if [[ -d /opt/frc-extensions-cache ]] && [[ -z "$(ls -A "$EXTENSIONS_DIR" 2>/dev/null)" ]]; then
  echo "Seeding VS Code extensions from image..."
  cp -a /opt/frc-extensions-cache/. "$EXTENSIONS_DIR"/
fi

touch "$SIM_LOG_FILE"

# Validate mounted project (warn only — the editor should still start).
if [[ ! -d /workspace/project ]]; then
  echo "WARNING: Mounted project directory /workspace/project does not exist."
elif [[ ! -f /workspace/project/build.gradle || ! -f /workspace/project/gradlew ]]; then
  echo "WARNING: Mounted project is missing build.gradle or gradlew."
fi

openvscode_args=(
  --host 0.0.0.0
  --port 3000
  --without-connection-token
  --extensions-dir "$EXTENSIONS_DIR"
  --user-data-dir "$DATA_DIR"
)

if [[ -n "${VSCODE_BASE_PATH:-}" && "${VSCODE_BASE_PATH:-/}" != "/" ]]; then
  openvscode_args+=(--server-base-path "$VSCODE_BASE_PATH")
fi

exec "${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server" \
  "${openvscode_args[@]}" \
  /workspace/project
