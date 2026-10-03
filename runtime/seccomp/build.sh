#!/usr/bin/env bash
# Builds seccomp-chrome.json: Docker's own default profile, plus one rule allowing what Chrome's
# sandbox needs to create user namespaces and chroot (v1 plan R12, ADR 0013). Nothing else is changed, so the
# whole difference from Docker's default is the rule below.
#
#   runtime/seccomp/build.sh           regenerate
#   runtime/seccomp/build.sh --check   fail if the committed file is not what this would produce
set -euo pipefail
cd "$(dirname "$0")"
MOBY_TAG=v25.0.5
SRC="https://raw.githubusercontent.com/moby/moby/$MOBY_TAG/profiles/seccomp/default.json"
OUT=seccomp-chrome.json

python3 - "$SRC" "$OUT.new" <<'PY'
import json, sys, urllib.request
src, out = sys.argv[1], sys.argv[2]
profile = json.load(urllib.request.urlopen(src, timeout=30))
profile["syscalls"].append({
    "names": ["clone", "unshare", "setns", "chroot"],
    "action": "SCMP_ACT_ALLOW",
    "comment": "Kestrel: Chrome's sandbox creates user, pid and network namespaces and chroots into an empty directory (ADR 0013). This is the only addition to Docker's default profile.",
})
with open(out, "w") as f:
    json.dump(profile, f, indent=2)
    f.write("\n")
PY

if [ "${1:-}" = "--check" ]; then
  if ! diff -q "$OUT" "$OUT.new" >/dev/null; then echo "$OUT is out of date; run runtime/seccomp/build.sh" >&2; rm -f "$OUT.new"; exit 1; fi
  rm -f "$OUT.new"
else
  mv "$OUT.new" "$OUT"
  echo "wrote $OUT from moby $MOBY_TAG"
fi
