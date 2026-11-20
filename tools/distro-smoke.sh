#!/bin/sh
# Inside a fresh distro container: install deps and Bun, install the given Superiss archive, run recur -> work.
#   distro-smoke.sh /path/superiss-X.Y.Z.tar.gz X.Y.Z
set -e
archive="$1" version="$2"
if command -v apt-get >/dev/null; then apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip ca-certificates bash >/dev/null
elif command -v dnf >/dev/null; then dnf install -y -q --allowerasing curl unzip ca-certificates bash findutils gzip tar >/dev/null
elif command -v apk >/dev/null; then apk add -q curl unzip ca-certificates bash libstdc++ libgcc >/dev/null
elif command -v pacman >/dev/null; then pacman -Syu --noconfirm --needed curl unzip ca-certificates bash findutils >/dev/null
elif command -v zypper >/dev/null; then zypper -q -n install curl unzip ca-certificates bash findutils gzip tar >/dev/null
elif command -v yum >/dev/null; then yum install -y -q curl unzip ca-certificates bash findutils gzip tar >/dev/null; fi
arch=$(uname -m); [ "$arch" = aarch64 ] || arch=x64
musl=""; [ -f /etc/alpine-release ] && musl="-musl"
curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-${arch}${musl}.zip"
cd /tmp && unzip -qo bun.zip && install -m 755 bun-linux-*/bun /usr/local/bin/bun
bash "$(dirname "$0")/install.sh" --version "$version" --from "$archive"
P=/srv/p; mkdir -p $P/.sis; echo ok > $P/README.md; DB=$P/.sis/p.db
sis recur name=h every_secs=60 start_at=$(( $(date +%s) - 1 )) template='{"title":"h","lane":"ops","oracle_cmd":"test -s README.md","allowed_paths":["README.md"],"meta":{"lesson":false}}' --db $DB >/dev/null
sis recur_tick --db $DB >/dev/null
SIS_DIRECT=1 sis work lane=ops once=true --db $DB --actor ci
test "$(sis list --db $DB | bun -e 'const d=JSON.parse(await Bun.stdin.text());console.log(d.map(x=>x.status).join(","))')" = closed
echo "distro smoke passed: $(. /etc/os-release && echo "$PRETTY_NAME")"
