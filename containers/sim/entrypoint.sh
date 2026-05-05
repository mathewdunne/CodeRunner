#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/frc}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
export SIM_LOG_FILE="${SIM_LOG_FILE:-$HOME/sim.log}"

mkdir -p "$HOME" "$GRADLE_USER_HOME"
touch "$SIM_LOG_FILE"

if [[ -d /opt/frc-gradle-cache && ! -d "$GRADLE_USER_HOME/caches" ]]; then
  cp -a /opt/frc-gradle-cache/. "$GRADLE_USER_HOME"/
fi

if [[ ! -d /workspace/project ]]; then
  echo "Mounted project directory /workspace/project does not exist." | tee -a "$SIM_LOG_FILE" >&2
elif [[ ! -f /workspace/project/build.gradle || ! -f /workspace/project/gradlew ]]; then
  echo "Mounted project is missing build.gradle or gradlew." | tee -a "$SIM_LOG_FILE" >&2
else
  /usr/local/bin/start-sim.sh || true
fi

exec tail -n +1 -F "$SIM_LOG_FILE" 2>/dev/null
