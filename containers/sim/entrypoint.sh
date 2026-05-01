#!/usr/bin/env bash
set -euo pipefail

cd /workspace/project
/usr/local/bin/start-sim.sh
exec tail -n +1 -F /workspace/sim.log
