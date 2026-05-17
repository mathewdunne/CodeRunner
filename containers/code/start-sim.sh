#!/usr/bin/env bash
set -euo pipefail

HOME="${HOME:-/config}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
GRADLE_PROJECT_CACHE_DIR="${GRADLE_PROJECT_CACHE_DIR:-$HOME/.gradle-project-sim}"
DEFAULT_GRADLE_SIM_JVMARGS="-Xms64m -Xmx384m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=96m -XX:+HeapDumpOnOutOfMemoryError -XX:ActiveProcessorCount=2 -Dfile.encoding=UTF-8"
GRADLE_SIM_JVMARGS="${GRADLE_SIM_JVMARGS:-$DEFAULT_GRADLE_SIM_JVMARGS}"
GRADLE_MAX_WORKERS="${GRADLE_MAX_WORKERS:-2}"
DEFAULT_ROBOT_SIM_JVMARGS="-Xms32m -Xmx256m -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=96m -XX:ActiveProcessorCount=2 -Dfile.encoding=UTF-8"
ROBOT_SIM_JVMARGS="${ROBOT_SIM_JVMARGS:-$DEFAULT_ROBOT_SIM_JVMARGS}"
pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"
log_file="${SIM_LOG_FILE:-$HOME/sim.log}"
project_root="${SIM_PROJECT_ROOT:-/workspace/project}"

mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")" "$GRADLE_USER_HOME" "$GRADLE_PROJECT_CACHE_DIR"

export GRADLE_USER_HOME GRADLE_PROJECT_CACHE_DIR
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
RUN_SIM_SCRIPT="${RUN_SIM_SCRIPT:-/usr/local/bin/run-sim.sh}"

# run-sim.sh runs Gradle to build + emit the external-sim descriptor, then
# exec's `java -jar` so this PID becomes the robot JVM. Setsid isolates the
# whole tree from start-sim.sh's session, matching the original lifecycle
# contract (one PID in pid_file that stays valid for the entire simulation,
# including the brief build window).
setsid "$RUN_SIM_SCRIPT" \
  "$project_root" \
  "$GRADLE_PROJECT_CACHE_DIR" \
  "$GRADLE_MAX_WORKERS" \
  "$GRADLE_SIM_JVMARGS" \
  "$ROBOT_SIM_JVMARGS" \
  "$INIT_SCRIPT" \
  >"$log_file" 2>&1 &
echo "$!" >"$pid_file"
echo "started sim with pid $(cat "$pid_file")"
