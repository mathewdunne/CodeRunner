#!/usr/bin/env bash
set -euo pipefail

pid_file=/workspace/sim.pid

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

process_tree_pids() {
  local root="$1"

  ps -eo pid=,ppid= | awk -v root="$root" '
    {
      pid = $1
      ppid = $2
      parent[pid] = ppid
      children[ppid] = children[ppid] " " pid
    }
    END {
      queue[1] = root
      seen[root] = 1
      head = 1
      tail = 1
      while (head <= tail) {
        pid = queue[head++]
        print pid
        split(children[pid], kids, " ")
        for (idx in kids) {
          child = kids[idx]
          if (child != "" && !seen[child]) {
            seen[child] = 1
            queue[++tail] = child
          }
        }
      }
    }
  '
}

process_tree_groups() {
  local root="$1"

  process_tree_pids "$root" | while read -r tree_pid; do
    ps -o pgid= -p "$tree_pid" 2>/dev/null || true
  done | awk '{ print $1 }' | sort -nu
}

if [[ ! -f "$pid_file" ]]; then
  echo "sim is not running"
  exit 0
fi

pid="$(cat "$pid_file")"
if [[ -z "$pid" ]] || ! is_running_process "$pid"; then
  rm -f "$pid_file"
  echo "sim is not running"
  exit 0
fi

echo "stopping sim with pid $pid"
mapfile -t groups < <(process_tree_groups "$pid")
for group in "${groups[@]}"; do
  [[ -n "$group" && "$group" != "1" ]] && kill -TERM "-$group" 2>/dev/null || true
done
kill -TERM "$pid" 2>/dev/null || true

for _ in {1..40}; do
  if ! is_running_process "$pid"; then
    rm -f "$pid_file"
    echo "sim stopped"
    exit 0
  fi
  sleep 0.25
done

echo "sim did not stop after 10s; killing"
mapfile -t groups < <(process_tree_groups "$pid")
for group in "${groups[@]}"; do
  [[ -n "$group" && "$group" != "1" ]] && kill -KILL "-$group" 2>/dev/null || true
done
kill -KILL "$pid" 2>/dev/null || true
rm -f "$pid_file"
