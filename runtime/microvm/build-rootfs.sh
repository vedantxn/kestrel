#!/usr/bin/env bash
# The microVM's root filesystem: the runtime image (kestrel-runtime:dev) exported to ext4, plus
# runtime/microvm/init. Read-only in the VM and shared by every clone. Run as root on the host:
#   sudo runtime/microvm/build-rootfs.sh [OUT]   (default /data/kestrel-vm/rootfs.ext4)
set -euo pipefail
IMAGE=${IMAGE:-kestrel-runtime:dev}
OUT=${1:-/data/kestrel-vm/rootfs.ext4}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$(dirname "$OUT")"
work=$(mktemp -d /data/kestrel-vm/rootfs.XXXX)
trap 'rm -rf "$work"' EXIT
cid=$(docker create "$IMAGE")
docker export "$cid" | tar -x -C "$work/" --exclude=dev/*
docker rm "$cid" >/dev/null
install -m 0755 "$HERE/init" "$work/init"
mkdir -p "$work/proc" "$work/sys" "$work/dev" "$work/run" "$work/tmp" "$work/profile" "$work/home/kestrel"
size=$(( $(du -sm "$work" | cut -f1) + 256 ))
rm -f "$OUT.tmp"
mkfs.ext4 -q -F -L kestrel-root -d "$work" "$OUT.tmp" "${size}M"
mv "$OUT.tmp" "$OUT"
echo "$OUT ($size MiB)"
