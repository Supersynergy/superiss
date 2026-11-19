#!/usr/bin/env bash
# Build the relocatable release archive and its checksum: tools/release-asset.sh OUTDIR
set -euo pipefail
out="${1:?usage: tools/release-asset.sh OUTDIR}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
version="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('$repo/packages/superiss/package.json','utf8')).version)")"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
bun "$repo/tools/package-v1.ts" "$stage/superiss-$version" --with-adapters >/dev/null
mkdir -p "$out"
COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out/superiss-$version.tar.gz" "superiss-$version"
cd "$out"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "superiss-$version.tar.gz"; else shasum -a 256 "superiss-$version.tar.gz"; fi > "superiss-$version.tar.gz.sha256"
cat "superiss-$version.tar.gz.sha256"
