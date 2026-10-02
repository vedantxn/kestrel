#!/usr/bin/env bash
# Build the runtime image. Run on a Linux host with Docker (the AWS host), from anywhere.
#   runtime/build.sh [tag]        default tag: kestrel-runtime:dev
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
tag="${1:-kestrel-runtime:dev}"

(cd "$root" && npm run bundle -w @kestrel/runtimed)
cp "$root/runtime/runtimed/dist/runtimed.mjs" "$here/runtimed.mjs"
docker build -f "$here/Dockerfile" --build-arg "CHROME_VERSION=$(cat "$here/CHROME_VERSION")" -t "$tag" "$here"
rm -f "$here/runtimed.mjs"
echo "built $tag"
