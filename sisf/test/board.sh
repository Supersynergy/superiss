#!/usr/bin/env bash
# sisf P3 check: board v2 endpoints + connector error path (no live gitea needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sisf-board-XXXX)"
cleanup() {
  for pid in "${SISF_PID:-}" "${SIS_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
cd "$TMP"
git init -q repo && cd repo && git config user.email t@t && git config user.name t
echo init > f.txt && git add -A && git commit -qm init && git branch -M main
cd "$TMP"
export SIS_DB="$TMP/sis.db"
"$ROOT/bin/sis" create --db "$SIS_DB" id=b1 title=board oracle_cmd="true" >/dev/null
"$ROOT/bin/sis" serve --db "$SIS_DB" & SIS_PID=$!
SOCK=/tmp/sis-$(python3 -c "import hashlib,os;print(hashlib.sha256(os.path.realpath('$SIS_DB').encode()).hexdigest()[:20])").sock
for i in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
PORT=$(( 19766 + RANDOM % 1000 ))
bun "$ROOT/sisf/sisf.ts" serve --db "$SIS_DB" --repo "$TMP/repo" --port "$PORT" & SISF_PID=$!
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
# board v2: HTML shell + JSON join
curl -sf "http://127.0.0.1:$PORT/forge" | grep -q 'SOLL — sis tasks' || { echo "FAIL forge html"; exit 1; }
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"acquire","args":{"id":"b1","actor":"a","ttl":120}}' >/dev/null
curl -sf "http://127.0.0.1:$PORT/forge/board" | python3 -c "import json,sys;d=json.load(sys.stdin);w=d['worktrees'];assert w and w[0]['task']=='b1',d;print('board-join ok')"
# connector without config → clear error, not crash
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/sisf/pr" -d '{"id":"b1"}' | grep -q 'no_connector' || { echo "FAIL connector error path"; exit 1; }
echo "BOARD ORACLE PASS"
