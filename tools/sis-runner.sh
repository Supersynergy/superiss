#!/usr/bin/env bash
# Foreground runner; use --once for a bounded invocation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "${SIS_RUNNER_PYTHON:-python3}" "$ROOT/tools/sis_runner.py" "$@"
