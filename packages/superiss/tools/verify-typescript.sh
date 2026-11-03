#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
unset SIS_DB SIS_SOCK SIS_HTTP SIS_DIRECT SIS_ADMIN_TOKEN SIS_MAX_CLIENTS SIS_IMPL SIS_CWD_DB SIS_SYNCHRONOUS
compiler="${SIS_TSC:-tsc}"
if [ -z "${SIS_TSC:-}" ]; then
  while IFS= read -r candidate; do
    if candidate_version="$("$candidate" --version 2>/dev/null)" && [[ "$candidate_version" == 'Version 7.1.'* ]]; then
      compiler="$candidate"
      break
    fi
  done < <(type -a -p tsc)
fi
version="$("$compiler" --version)"
case "$version" in
  'Version 7.1.'*) ;;
  *) printf 'TypeScript 7.1 required; found %s\n' "$version" >&2; exit 1 ;;
esac
if [ -n "${SIS_TYPE_ROOTS:-}" ]; then
  "$compiler" --project tsconfig.json --typeRoots "$SIS_TYPE_ROOTS"
else
  "$compiler" --project tsconfig.json
fi
if [ "${1:-}" = "--typecheck" ]; then exit 0; fi
bun test ts/store.test.ts
reference_env=(CARGO_ENCODED_RUSTFLAGS= RUSTC_WRAPPER= CARGO_BUILD_JOBS=4)
if [ -n "${SIS_REFERENCE_TOOLCHAIN:-}" ]; then
  reference_env+=("RUSTUP_TOOLCHAIN=$SIS_REFERENCE_TOOLCHAIN")
fi
env "${reference_env[@]}" python3 tests/agent_suite.py --impl ts
python3 tests/integration_suite.py --impl ts
python3 tests/contract_suite.py --require-complete --serve-cmd "env SIS_IMPL=ts ./bin/sis serve"
