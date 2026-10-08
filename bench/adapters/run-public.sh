#!/usr/bin/env bash
# Run the public harnesses (with the Kestrel adapters installed) for each provider, from a runner
# in the deployment's region. Results are copied to $OUT after every step.
#   KESTREL_URL=... KESTREL_API_KEY=... [HYPERBROWSER_API_KEY=...] run-public.sh <work dir> <providers...>
#   steps: ARENA_RUNS (100), ARENA_CONCURRENCY (10), CSDK_ITERATIONS (50), CSDK_THROUGHPUT (10)
#   KESTREL_SETTINGS: how the deployment was set up, recorded with the results, e.g.
#     "RUNTIME_A=microvm SLOTS_A=12 POOL_A=12 createsPerMinute=6000 m7i.2xlarge"
set -uo pipefail
W=${1:?usage: run-public.sh <work dir> <providers...>}; shift
OUT=$W/out/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT"
# The arena repo ships its own published results in the folder runs write to; clear them so this
# run's numbers are never mixed with theirs.
rm -rf "$W/arena/results/hello-browser"
# What a reader needs to rerun this: when, from where, the harnesses' commits and the deployment.
cat > "$OUT/settings.json" <<JSON
{
  "startedAt": "$(date -u +%FT%TZ)",
  "providers": "$*",
  "runner": "$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' | xargs -I{} curl -s -m 2 -H 'X-aws-ec2-metadata-token: {}' http://169.254.169.254/latest/meta-data/instance-type 2>/dev/null || uname -n)",
  "arenaCommit": "$(git -C "$W/arena" rev-parse --short HEAD 2>/dev/null)",
  "computesdkCommit": "$(git -C "$W/csdk" rev-parse --short HEAD 2>/dev/null)",
  "kestrelHost": "$(printf '%s' "${KESTREL_URL:-}" | sed -E 's#^https?://##; s#/.*##')",
  "kestrelSettings": "${KESTREL_SETTINGS:-}",
  "steps": {"arenaRuns": ${ARENA_RUNS:-100}, "arenaConcurrency": ${ARENA_CONCURRENCY:-10}, "csdkIterations": ${CSDK_ITERATIONS:-50}, "csdkThroughput": ${CSDK_THROUGHPUT:-10}}
}
JSON
for p in "$@"; do
  echo "== $p: Browser Arena sequential"
  (cd "$W/arena" && node dist/cli.js --provider="$p" --runs="${ARENA_RUNS:-100}") >"$OUT/arena-$p-c1.log" 2>&1
  if [ "${ARENA_CONCURRENCY:-10}" != 0 ]; then # 0 skips it (a plan that allows one session at a time)
    echo "== $p: Browser Arena at ${ARENA_CONCURRENCY:-10} concurrent"
    (cd "$W/arena" && node dist/cli.js --provider="$p" --runs="${ARENA_RUNS:-100}" --concurrency="${ARENA_CONCURRENCY:-10}") >"$OUT/arena-$p-c${ARENA_CONCURRENCY:-10}.log" 2>&1
  fi
  echo "== $p: ComputeSDK lifecycle"
  (cd "$W/csdk" && npx tsx packages/benchsdk-runner/dist/bin.js run benchmarks/browser/browser.bench.ts --provider "$p" --iterations "${CSDK_ITERATIONS:-50}" --no-ingest) >"$OUT/csdk-lifecycle-$p.log" 2>&1
  cp "$W/csdk/results/browser/latest.json" "$OUT/csdk-lifecycle-$p.json" 2>/dev/null
  if [ "${CSDK_THROUGHPUT:-10}" != 0 ]; then
    echo "== $p: ComputeSDK throughput"
    (cd "$W/csdk" && npx tsx packages/benchsdk-runner/dist/bin.js run benchmarks/browser/browser-throughput.bench.ts --provider "$p" --iterations "${CSDK_THROUGHPUT:-10}" --no-ingest) >"$OUT/csdk-throughput-$p.log" 2>&1
    cp "$W/csdk/results/browser-throughput/latest.json" "$OUT/csdk-throughput-$p.json" 2>/dev/null
  fi
done
cp -R "$W/arena/results" "$OUT/arena-results"
echo "RUN-DONE $OUT"
