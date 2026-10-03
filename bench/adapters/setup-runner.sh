#!/usr/bin/env bash
# Install both public harnesses, with the Kestrel adapters, on a benchmark runner (runner.tf).
#   KESTREL_TARGET=runner bin/host run -- bash /srv/kestrel/bench/adapters/setup-runner.sh
set -euo pipefail
W=${1:-$HOME/bench}
A=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$W/tools"
cp "$A/summarize.py" "$W/tools/"
[ -d "$W/arena" ] || node "$A/browserarena/install.mjs" "$W/arena"
[ -d "$W/csdk" ] || node "$A/computesdk/install.mjs" "$W/csdk"
node "$A/browserarena/install.mjs" "$W/arena" >/dev/null
node "$A/computesdk/install.mjs" "$W/csdk" >/dev/null
(cd "$W/arena" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
(cd "$W/csdk" && npx -y pnpm@10.33.0 install --frozen-lockfile >/dev/null)
echo SETUP-DONE
