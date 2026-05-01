#!/usr/bin/env bash
set -euo pipefail

pid_file=/workspace/sim.pid
log_file=/workspace/sim.log

if [[ -f "$pid_file" ]]; then
  pid="$(cat "$pid_file")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "sim already running with pid $pid"
    exit 0
  fi
fi

cd /workspace/project
rm -f "$log_file"

setsid ./gradlew --no-daemon --console=plain simulateJava >"$log_file" 2>&1 &
echo "$!" > "$pid_file"
echo "started sim with pid $(cat "$pid_file")"
