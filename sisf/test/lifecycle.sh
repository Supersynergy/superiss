#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sisf-lifecycle-XXXX)"
cleanup() {
  for pid in "${SISF_PID:-}" "${SIS_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
mkdir "$TMP/repo"
git -C "$TMP/repo" init -qb main
git -C "$TMP/repo" config user.name Test
git -C "$TMP/repo" config user.email test@example.invalid
echo init > "$TMP/repo/f"
git -C "$TMP/repo" add f
git -C "$TMP/repo" commit -qm init
export SIS_DB="$TMP/sis.db"
"$ROOT/bin/sis" create id=direct title=direct oracle_cmd=true 'allowed_paths=["."]' --db "$SIS_DB" >/dev/null
"$ROOT/bin/sis" serve --db "$SIS_DB" & SIS_PID=$!
SOCK=/tmp/sis-$(python3 -c "import hashlib,os; print(hashlib.sha256(os.path.realpath('$SIS_DB').encode()).hexdigest()[:20])").sock
for i in $(seq 1 100); do [[ ! -S "$SOCK" ]] || break; sleep .05; done
PORT=$(( 22000 + RANDOM % 1000 ))
start_forge() {
  bun "$ROOT/sisf/sisf.ts" serve --db "$SIS_DB" --repo "$TMP/repo" --port "$PORT" & SISF_PID=$!
  for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && return; sleep .05; done
  return 1
}
start_forge
"$ROOT/bin/sis" acquire id=direct actor=socket-worker ttl=120 --db "$SIS_DB" >/dev/null
for i in $(seq 1 100); do [[ ! -f "$TMP/repo/.sisf/wt/direct/f" ]] || break; sleep .05; done
[[ -f "$TMP/repo/.sisf/wt/direct/f" ]]
# The cursor must be durable before a restart; no replay creates another tree.
CURSOR="$(bun -e 'import {Database} from "bun:sqlite"; console.log(new Database(process.argv[1]).query("SELECT v FROM kv WHERE k=?").get("last_seq").v)' "$TMP/sisf.state.db")"
[[ "$CURSOR" -gt 0 ]]
kill "$SISF_PID"; wait "$SISF_PID" 2>/dev/null || true
start_forge
curl -sf "http://127.0.0.1:$PORT/forge/board" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert len(d["worktrees"])==1 and d["worktrees"][0]["epoch"]==1,d'
# Boundary checks hit the actual HTTP server.
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/" -d '{}')" == 403 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H 'Origin: https://evil.invalid' -X POST "http://127.0.0.1:$PORT/" -d '{}')" == 403 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.invalid' "http://127.0.0.1:$PORT/health")" == 403 ]]
[[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{')" == 400 ]]
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"cancel","args":{"id":"direct","actor":"socket-worker","epoch":1}}' >/dev/null
curl -sf "http://127.0.0.1:$PORT/sisf/worktrees" | python3 -c 'import json,sys;assert json.load(sys.stdin)["data"][0]["status"]=="active"'
[[ "$(head -c 1048577 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" --data-binary @-)" == 413 ]]
# Unknown actor cannot write artifact evidence.
curl -s -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/sisf/commit" -d '{"id":"direct","actor":"other","epoch":1}' | python3 -c 'import json,sys;assert json.load(sys.stdin)["ok"] is False'
# Missing connector must not push anything. No origin exists in this fixture.
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/sisf/pr" -d '{"id":"direct"}' | python3 -c 'import json,sys;assert json.load(sys.stdin)["error"]["code"]=="no_connector"'
echo "LIFECYCLE ORACLE PASS"
