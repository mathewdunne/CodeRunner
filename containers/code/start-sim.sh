#!/usr/bin/env bash
set -euo pipefail

HOME="${HOME:-/config}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
GRADLE_PROJECT_CACHE_DIR="${GRADLE_PROJECT_CACHE_DIR:-$HOME/.gradle-project-sim}"
pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"
log_file="${SIM_LOG_FILE:-$HOME/sim.log}"
project_root="${SIM_PROJECT_ROOT:-/workspace/project}"

mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")" "$GRADLE_USER_HOME" "$GRADLE_PROJECT_CACHE_DIR"

export SIM_PROJECT_ROOT="$project_root"
/usr/local/bin/stop-sim.sh >/dev/null 2>&1 || true

cd "$project_root"
if [[ ! -f build.gradle || ! -f gradlew ]]; then
  echo "Cannot start sim: mounted project is missing build.gradle or gradlew." >"$log_file"
  exit 1
fi

sed -i 's/\r$//' gradlew 2>/dev/null || true
chmod +x gradlew 2>/dev/null || true
rm -f "$log_file"

# HALSim WebSocket server: bind to all interfaces so the host can reach it
# through the published loopback port. Port is configurable via HALSIMWS_PORT
# (defaults to 3300 per the WPILib spec).
export HALSIMWS_HOST="${HALSIMWS_HOST:-0.0.0.0}"
export HALSIMWS_PORT="${HALSIMWS_PORT:-3300}"

INIT_SCRIPT="/usr/local/share/frc/sim-headless.init.gradle"

init_script_args=()
if [[ -f "$INIT_SCRIPT" ]]; then
  init_script_args=(--init-script "$INIT_SCRIPT")
fi

setsid ./gradlew --no-daemon --console=plain --project-cache-dir "$GRADLE_PROJECT_CACHE_DIR" "${init_script_args[@]}" simulateJava >"$log_file" 2>&1 &
echo "$!" >"$pid_file"
echo "started sim with pid $(cat "$pid_file")"
