#!/usr/bin/env bash
# Install a Superiss release bundle on Linux or macOS, as root (system) or as a user.
#   tools/install.sh [--version X.Y.Z] [--from FILE_OR_HTTPS_URL] [--prefix DIR] [--bin-dir DIR] [--sandbox] [--insecure-no-checksum]
# Defaults: root -> /opt/superiss + /usr/local/bin, user -> ~/.local/share/superiss + ~/.local/bin.
# Earlier releases stay installed; rollback = point <prefix>/current back to the printed previous release.
set -euo pipefail

version=1.6.0 from= prefix= bindir= sandbox=0 nocheck=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --prefix) prefix="$2"; shift 2 ;;
    --bin-dir) bindir="$2"; shift 2 ;;
    --sandbox) sandbox=1; shift ;;
    --insecure-no-checksum) nocheck=1; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'invalid version: %s\n' "$version" >&2; exit 2; }
if [ "$(id -u)" = 0 ]; then prefix="${prefix:-/opt/superiss}"; bindir="${bindir:-/usr/local/bin}"
else prefix="${prefix:-$HOME/.local/share/superiss}"; bindir="${bindir:-$HOME/.local/bin}"; fi

need() { command -v "$1" >/dev/null 2>&1 || { printf 'missing required command: %s\n' "$1" >&2; exit 3; }; }
need tar
command -v bun >/dev/null 2>&1 || { printf 'Bun >= 1.4.4 is required and is not installed automatically (https://bun.sh).\n' >&2; exit 3; }
bunv="$(bun --version)"
[ "$(printf '%s\n1.4.4\n' "$bunv" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = 1.4.4 ] || { printf 'Bun %s is older than 1.4.4\n' "$bunv" >&2; exit 3; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
json() { bun -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(String(m[process.argv[2]]??""))' "$1" "$2"; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
archive="$work/superiss.tar.gz"
[ -n "$from" ] || from="https://github.com/Supersynergy/superiss/releases/download/v$version/superiss-$version.tar.gz"
case "$from" in
  https://*)
    need curl
    curl -fsSL --proto '=https' --max-time 300 -o "$archive" "$from"
    curl -fsSL --proto '=https' --max-time 60 -o "$work/expected" "$from.sha256" ;;
  http://*) printf 'refusing plain http: %s\n' "$from" >&2; exit 2 ;;
  *) cp "$from" "$archive"; [ ! -f "$from.sha256" ] || cp "$from.sha256" "$work/expected" ;;
esac
if [ -f "$work/expected" ]; then
  [ "$(sha256 "$archive")" = "$(cut -d' ' -f1 "$work/expected")" ] || { printf 'checksum mismatch for %s\n' "$from" >&2; exit 4; }
elif [ "$nocheck" = 0 ]; then printf 'no %s.sha256 next to the archive; pass --insecure-no-checksum to install anyway\n' "$from" >&2; exit 4; fi

mkdir "$work/x" && tar --no-same-owner -C "$work/x" -xzf "$archive"
manifests="$(find "$work/x" -mindepth 2 -maxdepth 2 -name manifest.json)"
[ "$(printf '%s\n' "$manifests" | grep -c .)" = 1 ] || { printf 'archive must contain exactly one top-level release with manifest.json\n' >&2; exit 4; }
root="$(dirname "$manifests")"
got="$(json "$root/manifest.json" version)"; hash="$(json "$root/manifest.json" sourceHash)"
[ "$got" = "$version" ] || { printf 'archive contains %s, expected %s\n' "$got" "$version" >&2; exit 4; }
[[ "$hash" =~ ^[0-9a-f]{12,}$ ]] || { printf 'invalid sourceHash in manifest\n' >&2; exit 4; }
# Probe the unpacked release before anything visible changes.
"$root/bin/sis" capabilities --db "$work/probe.db" > "$work/caps.json"

target="$prefix/releases/$version-${hash:0:12}"
mkdir -p "$prefix/releases" "$bindir"
if [ -e "$target" ]; then printf 'already installed: %s\n' "$target"
else
  rm -rf "$target.tmp.$$"; cp -R "$root" "$target.tmp.$$" || { rm -rf "$target.tmp.$$"; exit 5; }
  chmod -R a+rX,go-w "$target.tmp.$$"; mv "$target.tmp.$$" "$target"
fi
previous="$(readlink "$prefix/current" 2>/dev/null || true)"
lock="$prefix/client-update.lock"; [ -e "$lock" ] || : > "$lock"
# Atomic switch: build the new link beside the old one and rename over it (under the client lock when flock exists).
switch() { ln -sfn "$target" "$prefix/.current.$$" && mv -f "$prefix/.current.$$" "$prefix/current"; }
if command -v flock >/dev/null 2>&1; then exec 9<>"$lock"; flock -x -w 120 9; switch; flock -u 9; else switch; fi
for tool in sis sisf; do
  link="$bindir/$tool"
  # Replace only our own links; a regular file or a link elsewhere (site wrapper) is kept.
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then ln -s "$prefix/current/bin/$tool" "$link"
  elif [ -L "$link" ] && case "$(readlink "$link")" in "$prefix"/*) true ;; *) false ;; esac; then ln -sfn "$prefix/current/bin/$tool" "$link"
  else printf 'kept existing %s (not managed by this prefix)\n' "$link"; fi
done

if [ "$sandbox" = 1 ] && [ "$(uname -s)" = Linux ]; then
  if ! command -v bwrap >/dev/null 2>&1; then
    printf 'bubblewrap missing: install it (apt-get install bubblewrap | dnf install bubblewrap | apk add bubblewrap) and rerun with --sandbox\n' >&2
  elif [ -d /etc/apparmor.d ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ]; then
    if [ "$(id -u)" != 0 ]; then printf 'AppArmor restricts user namespaces: rerun as root with --sandbox to allow them for bwrap only\n' >&2
    elif [ -e /etc/apparmor.d/bwrap ] && ! grep -q 'userns,' /etc/apparmor.d/bwrap; then printf 'kept existing /etc/apparmor.d/bwrap without userns; review it manually\n' >&2
    elif [ ! -e /etc/apparmor.d/bwrap ]; then
      printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap %s flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n' "$(command -v bwrap)" > /etc/apparmor.d/bwrap
      apparmor_parser -r /etc/apparmor.d/bwrap
    fi
  fi
fi

"$prefix/current/bin/sis" capabilities --db "$work/probe2.db" > "$work/caps.json"
printf 'installed %s (previous: %s)\n' "$target" "${previous:-none}"
bun -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({version:c.version,operations:c.operations.length,local_zero_execution:c.local_zero_execution}))' "$work/caps.json"
[ -z "$previous" ] || printf 'rollback: ln -sfn %s %s/current\n' "$previous" "$prefix"
printf 'Running daemons keep their version until restarted. Service file: sis unit --db DB --sock SOCK\n'
