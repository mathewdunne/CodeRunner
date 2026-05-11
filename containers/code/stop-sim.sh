#!/usr/bin/env bash
set -euo pipefail

HOME="${HOME:-/config}"
pid_file="${SIM_PID_FILE:-$HOME/sim.pid}"
project_root="${SIM_PROJECT_ROOT:-/workspace/project}"

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

sim_candidate_pids() {
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && is_running_process "$pid"; then
      echo "$pid"
    fi
  fi

  ps -eo pid=,args= | while read -r pid args; do
    [[ -n "${pid:-}" && -n "${args:-}" ]] || continue
    [[ "$pid" != "$$" && "$pid" != "$BASHPID" ]] || continue
    case "$args" in
      *"org.gradle.wrapper.GradleWrapperMain"*simulateJava*|*"$project_root/build/libs/"*.jar*)
        echo "$pid"
        ;;
    esac
  done
}

current_process_group() {
  ps -o pgid= -p "$$" 2>/dev/null | awk '{ print $1 }'
}

target_groups_for() {
  local current_group
  current_group="$(current_process_group)"

  for pid in "$@"; do
    [[ -n "$pid" ]] || continue
    process_tree_groups "$pid"
  done | awk -v current_group="$current_group" '
    $1 != "" && $1 != "1" && $1 != current_group { print $1 }
  ' | sort -nu
}

groups_with_processes() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local wanted
  wanted="$(printf '%s\n' "$@" | awk 'NF { wanted[$1] = 1 } END { for (group in wanted) print group }')"
  ps -eo pgid= | awk -v wanted="$wanted" '
    BEGIN {
      split(wanted, groups, "\n")
      for (idx in groups) {
        if (groups[idx] != "") wanted_group[groups[idx]] = 1
      }
    }
    wanted_group[$1] { remaining[$1] = 1 }
    END {
      for (group in remaining) print group
    }
  ' | sort -nu
}

send_signal_to_groups() {
  local signal="$1"
  shift
  local groups=("$@")

  for group in "${groups[@]}"; do
    [[ -n "$group" ]] || continue
    kill "-$signal" "-$group" 2>/dev/null || true
  done
}

send_signal_to_pids() {
  local signal="$1"
  shift
  local candidates=("$@")
  for pid in "${candidates[@]}"; do
    [[ -n "$pid" ]] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

mapfile -t candidates < <(sim_candidate_pids | sort -nu)
if [[ "${#candidates[@]}" -eq 0 ]]; then
  rm -f "$pid_file"
  echo "sim is not running"
  exit 0
fi

echo "stopping sim process(es): ${candidates[*]}"
mapfile -t target_groups < <(target_groups_for "${candidates[@]}")
send_signal_to_groups TERM "${target_groups[@]}"
send_signal_to_pids TERM "${candidates[@]}"

for _ in {1..40}; do
  mapfile -t remaining < <(sim_candidate_pids | sort -nu)
  mapfile -t remaining_groups < <(groups_with_processes "${target_groups[@]}")
  if [[ "${#remaining[@]}" -eq 0 && "${#remaining_groups[@]}" -eq 0 ]]; then
    rm -f "$pid_file"
    echo "sim stopped"
    exit 0
  fi
  sleep 0.25
done

echo "sim did not stop after 10s; killing"
mapfile -t remaining < <(sim_candidate_pids | sort -nu)
mapfile -t remaining_groups < <(groups_with_processes "${target_groups[@]}")
send_signal_to_groups KILL "${remaining_groups[@]}"
send_signal_to_pids KILL "${remaining[@]}"
rm -f "$pid_file"
