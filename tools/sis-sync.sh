#!/usr/bin/env bash
# sis-sync — Git-backed sync for the .issues.jsonl snapshot mirror.
#
# Each host keeps its own local SQLite store (never committed). The
# committed artifact is <name>.issues.jsonl next to the store, rewritten
# after every write op. Sync = pull remote snapshot lines -> import
# (upsert, last-writer-wins per issue) -> snapshot local state -> commit
# -> push. There is no DB merge; the JSONL file is the only shared truth.
#
# Usage:
#   sis-sync.sh status   # show snapshot vs HEAD
#   sis-sync.sh pull     # git pull --rebase, then import remote snapshot
#   sis-sync.sh push     # snapshot + commit + push
#   sis-sync.sh sync     # pull then push
#
# Required: --db PATH or SIS_DB (inside a git worktree). pull needs
# SIS_ADMIN_TOKEN (import is an administrative op) unless the store is
# served by a daemon that already holds it.
#
# 0.7+: for direct store-to-store replication without git use
# `sis sync_export` + `sis sync_import` (admin) — bundle carries
# schema/project_id, memory LWW, and never overwrites live claims.
set -euo pipefail

SIS="${SIS_BIN:-sis}"
MODE="${1:-sync}"

db=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --db) db="$2"; shift 2 ;;
    --db=*) db="${1#--db=}"; shift ;;
    *) echo "sis-sync: unknown arg $1" >&2; exit 2 ;;
  esac
done
db="${db:-${SIS_DB:-}}"
[ -n "$db" ] || { echo "sis-sync: pass --db PATH or set SIS_DB" >&2; exit 2; }
[ -f "$db" ] || { echo "sis-sync: store $db does not exist" >&2; exit 2; }

snap="$(dirname "$db")/$(basename "$db" .db).issues.jsonl"
gitroot="$(cd "$(dirname "$db")" && git rev-parse --show-toplevel 2>/dev/null)" \
  || { echo "sis-sync: $db is not inside a git worktree" >&2; exit 2; }
cd "$gitroot"
rel="$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1]))" "$snap")"

import_snap() {
  [ -f "$snap" ] || { echo "sis-sync: no snapshot at $rel, nothing to import"; return 0; }
  [ -n "${SIS_ADMIN_TOKEN:-}" ] || {
    echo "sis-sync: SIS_ADMIN_TOKEN unset — snapshot pulled but NOT imported" >&2
    return 1
  }
  "$SIS" --db "$db" import \
    "{\"path\":\"$snap\",\"admin_token\":\"$SIS_ADMIN_TOKEN\"}"
}

case "$MODE" in
  status)
    git status --porcelain -- "$rel"
    git log --oneline -3 -- "$rel" || true ;;
  pull)
    git pull --rebase
    import_snap ;;
  push)
    "$SIS" --db "$db" snapshot >/dev/null
    git add -- "$rel"
    if git diff --cached --quiet -- "$rel"; then
      echo "sis-sync: snapshot unchanged"
    else
      git commit -m "sis: task snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push
    fi ;;
  sync)
    git pull --rebase
    import_snap
    "$SIS" --db "$db" snapshot >/dev/null
    git add -- "$rel"
    if git diff --cached --quiet -- "$rel"; then
      echo "sis-sync: snapshot unchanged"
    else
      git commit -m "sis: task snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      git push
    fi ;;
  *) echo "usage: sis-sync.sh {status|pull|push|sync} [--db PATH]" >&2; exit 2 ;;
esac
