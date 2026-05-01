#!/usr/bin/env bash
set -euo pipefail

pid_file=/workspace/sim.pid

if [[ ! -f "$pid_file" ]]; then
  echo "sim is not running"
  exit 0
fi

pid="$(cat "$pid_file")"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file"
  echo "sim is not running"
  exit 0
fi

echo "stopping sim with pid $pid"
kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

for _ in {1..40}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    echo "sim stopped"
    exit 0
  fi
  sleep 0.25
done

echo "sim did not stop after 10s; killing"
kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
rm -f "$pid_file"
