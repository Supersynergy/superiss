#!/usr/bin/env bash
# sisf P4 check: lane policy binding + stale-worktree list + ci error path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sisf-p4-XXXX)"
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
cd "$TMP" && mkdir .sis
cat > .sis/sisf.config.json <<CFG
{"repo":"$TMP/repo","lanes":{"devin":{"paths":["src","docs"]}}}
CFG
export SIS_DB="$TMP/.sis/sis.db"
"$ROOT/bin/sis" create --db "$SIS_DB" id=p1 title=pol oracle_cmd="true" lane=devin >/dev/null
"$ROOT/bin/sis" create --db "$SIS_DB" id=p2 title=pol2 oracle_cmd="true" >/dev/null
"$ROOT/bin/sis" serve --db "$SIS_DB" & SIS_PID=$!
SOCK=/tmp/sis-$(python3 -c "import hashlib,os;print(hashlib.sha256(os.path.realpath('$SIS_DB').encode()).hexdigest()[:20])").sock
for i in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done
PORT=$(( 20766 + RANDOM % 1000 ))
bun "$ROOT/sisf/sisf.ts" serve --db "$SIS_DB" --port "$PORT" & SISF_PID=$!
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
# lane policy: task in lane devin gets the policy bound into the response
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"acquire","args":{"id":"p1","actor":"a","ttl":120}}' \
  | grep -q '"lane_policy".*src' || { echo "FAIL lane policy"; exit 1; }
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"acquire","args":{"id":"p2","actor":"b","ttl":120}}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);assert 'lane_policy' not in d['data'].get('sisf',{}),d;print('no-policy ok')"
# release → stale list via prune dry-run
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"unclaim","args":{"id":"p2","actor":"b","epoch":1}}' >/dev/null
bun "$ROOT/sisf/sisf.ts" prune --db "$SIS_DB" | grep -q 'p2' || { echo "FAIL stale list"; exit 1; }
# ci without gitea → clear error
(bun "$ROOT/sisf/sisf.ts" ci p1 --db "$SIS_DB" || true) | grep -q 'no_connector' || { echo "FAIL ci error"; exit 1; }
echo "P4 ORACLE PASS"
