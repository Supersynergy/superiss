#!/usr/bin/env bash
# Node-only host (for example FreeBSD): install the archive, run the daemon, a recurrence and the worker over the socket.
#   node-smoke.sh /path/superiss-X.Y.Z.tar.gz X.Y.Z
set -euo pipefail
archive="$1" version="$2"
here="$(cd "$(dirname "$0")" && pwd)"
base="$(mktemp -d)"
bash "$here/install.sh" --version "$version" --from "$archive" --prefix "$base/sis" --bin-dir "$base/bin"
SIS="$base/bin/sis" P="$base/p"; mkdir -p "$P/.sis"; echo ok > "$P/README.md"; DB="$P/.sis/p.db" SOCK="$P/.sis/p.sock"
cd "$P"
"$SIS" serve --db "$DB" --sock "$SOCK" 2>"$P/serve.log" & daemon=$!
for _ in $(seq 1 80); do [ -S "$SOCK" ] && break; sleep 0.25; done
[ -S "$SOCK" ] || { cat "$P/serve.log"; exit 1; }
"$SIS" recur name=h every_secs=60 start_at=$(( $(date +%s) - 1 )) template='{"title":"h","lane":"ops","oracle_cmd":"test -s README.md","allowed_paths":["README.md"],"meta":{"lesson":false}}' --db "$DB" --sock "$SOCK" >/dev/null
"$SIS" recur_tick --db "$DB" --sock "$SOCK" >/dev/null
"$SIS" work lane=ops once=true --db "$DB" --sock "$SOCK" --actor node-smoke
test "$("$SIS" stats --db "$DB" --sock "$SOCK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).closed))')" = 1
kill "$daemon"; wait "$daemon" 2>/dev/null || true
echo "node smoke passed: $(uname -sr) node $(node --version)"
