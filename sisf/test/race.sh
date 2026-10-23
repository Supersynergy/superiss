#!/usr/bin/env bash
# sisf P2 oracle: 2 claims → 2 isolated worktrees, independent diffs, attestation lands.
# Self-contained: own git repo + own sis db + own sisf daemon on ephemeral port.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sisf-race-XXXX)"
cleanup() {
  for pid in "${SISF_PID:-}" "${SIS_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$TMP"
}
trap cleanup EXIT
cd "$TMP"

# --- fixture: bare-able git repo with one commit ---
git init -q repo && cd repo && git config user.email t@t && git config user.name t
echo init > f.txt && git add -A && git commit -qm init && git branch -M main
cd "$TMP"

# --- sis store + daemon ---
export SIS_DB="$TMP/sis.db"
"$ROOT/bin/sis" create --db "$SIS_DB" id=t1 title=task1 oracle_cmd="true" 'allowed_paths=["."]' >/dev/null
"$ROOT/bin/sis" create --db "$SIS_DB" id=t2 title=task2 oracle_cmd="true" 'allowed_paths=["."]' >/dev/null
"$ROOT/bin/sis" serve --db "$SIS_DB" &
SIS_PID=$!
SOCK=/tmp/sis-$(python3 -c "import hashlib,os;print(hashlib.sha256(os.path.realpath('$SIS_DB').encode()).hexdigest()[:20])").sock
for i in $(seq 1 100); do [ -S "$SOCK" ] && break; sleep 0.1; done

# --- sisf daemon on random port ---
PORT=$(( 18766 + RANDOM % 1000 ))
bun "$ROOT/sisf/sisf.ts" serve --db "$SIS_DB" --repo "$TMP/repo" --port "$PORT" &
SISF_PID=$!
for i in $(seq 1 100); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.1; done
curl -sf "http://127.0.0.1:$PORT/health" | grep -q '"ok":true' || { echo "FAIL health"; exit 1; }

# --- the race: two proxied claims, different actors ---
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"acquire","args":{"id":"t1","actor":"agent-a","ttl":120}}' > "$TMP/claim-a.json" & A=$!
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/" -d '{"cmd":"acquire","args":{"id":"t2","actor":"agent-b","ttl":120}}' > "$TMP/claim-b.json" & B=$!
wait "$A"; wait "$B"
python3 -c 'import json,sys; ds=[json.load(open(p)) for p in sys.argv[1:]]; assert all(d["ok"] and d["data"]["sisf"]["bound"] for d in ds),ds; assert ds[0]["data"]["sisf"]["worktree"]!=ds[1]["data"]["sisf"]["worktree"]' "$TMP/claim-a.json" "$TMP/claim-b.json"

# --- isolation proof: disjoint dirs, independent diffs ---
echo a > "$TMP/repo/.sisf/wt/t1/a.txt"
echo b > "$TMP/repo/.sisf/wt/t2/b.txt"
[ -f "$TMP/repo/.sisf/wt/t1/a.txt" ] && [ ! -f "$TMP/repo/.sisf/wt/t1/b.txt" ] \
  && [ -f "$TMP/repo/.sisf/wt/t2/b.txt" ] && [ ! -f "$TMP/repo/.sisf/wt/t2/a.txt" ] \
  || { echo "FAIL worktree isolation"; exit 1; }
[ "$(cd "$TMP/repo/.sisf/wt/t1" && git branch --show-current)" = "sis/t1" ] || { echo "FAIL branch"; exit 1; }

# --- commit attestation over the socket path ---
cd "$TMP/repo/.sisf/wt/t1" && git add a.txt && git commit -qm "t1 work" && cd "$TMP"
curl -sf -H 'content-type: application/json' -X POST "http://127.0.0.1:$PORT/sisf/commit" -d '{"id":"t1","actor":"agent-a","epoch":1}' | grep -q '"ok":true' || { echo "FAIL commit attest"; exit 1; }
"$ROOT/bin/sis" changes --db "$SIS_DB" id=t1 repo="$TMP/repo/.sisf/wt/t1" base=main | grep -q 'a.txt' || { echo "FAIL sis changes"; exit 1; }

# --- double-claim must fail (sis atomicity) ---
OUT="$("$ROOT/bin/sis" acquire --db "$SIS_DB" id=t1 actor=agent-c ttl=60 2>&1 || true)"
echo "$OUT" | grep -qE '"ok":false|not_claimable|error' || { echo "FAIL atomic claim: $OUT"; exit 1; }

echo "RACE ORACLE PASS"
