#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
unset SIS_DB SIS_SOCK SIS_HTTP SIS_IMPL SISF_PORT SISF_GITEA_URL SISF_GITEA_TOKEN
bun test sisf
bun build sisf/sisf.ts --target=bun --outdir=.cache/sisf-check
bash -n bin/sisf sisf/test/*.sh
for check in race board p4 lifecycle; do
  bash "sisf/test/$check.sh"
done
echo "FORGE ACCEPTANCE PASS"
