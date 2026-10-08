#!/usr/bin/env bash
# Build the runtime image. Run on a Linux host with Docker (the AWS host), from anywhere.
#   runtime/build.sh [tag]        default tag: kestrel-runtime:dev
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
tag="${1:-kestrel-runtime:dev}"

if command -v npm >/dev/null 2>&1; then
  (cd "$root" && npm run bundle -w @kestrel/runtimed)
else
  # A fresh host has no Node: bundle inside a throwaway container (no native modules are needed).
  docker run --rm -v "$root:/w" -w /w node:24-bookworm-slim sh -c 'npm ci --ignore-scripts --no-audit --no-fund && npm run build -w @kestrel/contracts && npm run bundle -w @kestrel/runtimed; code=$?; chmod -R a+rwX /w 2>/dev/null; exit $code'
fi
cp "$root/runtime/runtimed/dist/runtimed.mjs" "$here/runtimed.mjs"
docker build -f "$here/Dockerfile" --build-arg "CHROME_VERSION=$(cat "$here/CHROME_VERSION")" -t "$tag" "$here"
rm -f "$here/runtimed.mjs"
echo "built $tag"
