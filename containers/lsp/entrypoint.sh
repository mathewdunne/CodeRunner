#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/frc}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"

mkdir -p "$HOME" "$GRADLE_USER_HOME" "${JDTLS_DATA:-/workspace/jdtls-data}"

if [[ -d /opt/frc-gradle-cache && ! -d "$GRADLE_USER_HOME/caches" ]]; then
  cp -a /opt/frc-gradle-cache/. "$GRADLE_USER_HOME"/
fi

if [[ ! -d /workspace/project ]]; then
  echo "Mounted project directory /workspace/project does not exist." >&2
fi

exec bun /opt/bridge/bridge.ts
