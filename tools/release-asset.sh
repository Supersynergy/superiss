#!/usr/bin/env bash
# Build the relocatable release archive and its checksum: tools/release-asset.sh OUTDIR
set -euo pipefail
out="${1:?usage: tools/release-asset.sh OUTDIR}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash on Windows: Bun needs native paths.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
# GNU tar reads "D:\\..." as host:path; use the POSIX form of a Windows output path.
if command -v cygpath >/dev/null 2>&1; then out="$(cygpath -u "$out")"; fi
mkdir -p "$out"; out="$(cd "$out" && pwd)"
cd "$repo"
version="$(bun -e "console.log(JSON.parse(require('fs').readFileSync('packages/superiss/package.json','utf8')).version)")"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
bun tools/package-v1.ts "$(native "$stage/superiss-$version")" --with-adapters >/dev/null
mkdir -p "$out"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$out/superiss-$version.tar.gz" "superiss-$version" 2>/dev/null || COPYFILE_DISABLE=1 tar -C "$stage" -czf "$out/superiss-$version.tar.gz" "superiss-$version"
cd "$out"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "superiss-$version.tar.gz"; else shasum -a 256 "superiss-$version.tar.gz"; fi > "superiss-$version.tar.gz.sha256"
cat "superiss-$version.tar.gz.sha256"
