#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
unset SIS_DB SIS_SOCK SIS_HTTP
for IMPL in rs py; do
  python3 tests/agent_suite.py --impl "$IMPL"
  python3 tests/integration_suite.py --impl "$IMPL"
  python3 tests/budget_suite.py --impl "$IMPL"
  python3 tests/controller_suite.py --impl "$IMPL"
  python3 tests/recovery_edges.py --impl "$IMPL"
  SIS_IMPL="$IMPL" python3 tests/contract_suite.py --serve-cmd "$ROOT/bin/sis serve"
done
bun test tests/service.test.ts tests/service-regression.test.ts tests/service-soak.test.ts tests/service-chaos.test.ts tests/service-defaults.test.ts
node --check mcp/sis-mcp.js
bash -n bin/sis
