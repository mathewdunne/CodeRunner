#!/usr/bin/env bash
set -euo pipefail

cd /workspace/project
exec ./gradlew --no-daemon --console=plain simulateJava
