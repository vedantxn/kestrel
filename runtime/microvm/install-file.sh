#!/usr/bin/env bash
# Put SRC at DST without ever writing into DST's file: a template's files are hard-linked into
# running VMs' jails, so rewriting one in place (cp onto it) would change it under them, and two
# template builds at once (hot and warm) would write into it together. The new content goes into a
# temporary file beside DST and is renamed over it, so DST's old inode, and every link to it, is
# left as it was. Nothing is done when DST already has SRC's content.
#   runtime/microvm/install-file.sh SRC DST
set -euo pipefail
src=$1
dst=$2
if [ -f "$dst" ] && cmp -s "$src" "$dst"; then exit 0; fi
tmp=$(mktemp "$dst.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp "$src" "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$dst"
trap - EXIT
