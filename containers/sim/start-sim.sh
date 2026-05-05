#!/usr/bin/env bash
set -euo pipefail

HOME="${HOME:-/home/frc}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.gradle}"
pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"
log_file="${SIM_LOG_FILE:-$HOME/sim.log}"

process_state() {
  local pid="$1"
  if [[ ! -r "/proc/$pid/stat" ]]; then
    return 1
  fi

  awk '{ print $3 }' "/proc/$pid/stat"
}

is_running_process() {
  local pid="$1"
  local state

  state="$(process_state "$pid" 2>/dev/null || true)"
  [[ -n "$state" && "$state" != "Z" ]]
}

mkdir -p "$(dirname "$pid_file")" "$(dirname "$log_file")" "$GRADLE_USER_HOME"

if [[ -f "$pid_file" ]]; then
  pid="$(cat "$pid_file")"
  if [[ -n "$pid" ]] && is_running_process "$pid"; then
    echo "sim already running with pid $pid"
    exit 0
  fi
fi

cd /workspace/project
if [[ ! -f build.gradle || ! -f gradlew ]]; then
  echo "Cannot start sim: mounted project is missing build.gradle or gradlew." >"$log_file"
  exit 1
fi

sed -i 's/\r$//' gradlew 2>/dev/null || true
chmod +x gradlew 2>/dev/null || true
rm -f "$log_file"

setsid ./gradlew --no-daemon --console=plain simulateJava >"$log_file" 2>&1 &
echo "$!" >"$pid_file"
echo "started sim with pid $(cat "$pid_file")"
