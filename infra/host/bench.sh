#!/usr/bin/env bash
# Run the exit-check harness on this host, inside the platform image: it needs the Docker socket,
# the secrets, the node's runtime directory and firewall access, because it compares exactly what
# cannot be seen from outside (v1 plan H3). Run as root; `bin/host bench` does.
#   sudo infra/host/bench.sh m1 [VAR=value ...]        QUICK=1 for a short pass
#   sudo infra/host/bench.sh invariants                one invariant check, nothing expected on
#   sudo infra/host/bench.sh profiles [VAR=value ...]  the profile checks (docs/lld/p18-profiles.md 10)
#
# For m1 and m2 the node agents are recreated with their probe controls on (KESTREL_HARNESS=on,
# docs/harness.md) and recreated with them off again when the run ends, however it ends.
# On a microVM node (RUNTIME_A=microvm) the harness reads VMs from the host: it runs privileged,
# in the host's PID and cgroup namespaces, with /run/netns and the VM directory (threat model G-25).
set -euo pipefail
cmd=${1:?usage: bench.sh m1|m2|invariants|churn|proxy|captcha|profiles [VAR=value ...]}; shift
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
set -a; . /var/lib/kestrel/compose.env; set +a
mkdir -p /var/lib/kestrel/reports /run/netns /data/kestrel-vm
# The machine's type, for the report: from AWS's metadata when there is any.
TOKEN=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
INSTANCE_TYPE=$([ -n "$TOKEN" ] && curl -s -m 2 -f -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type || true)
INSTANCE_TYPE=${INSTANCE_TYPE:-$(nproc) vCPU, $(awk '/MemTotal/ {printf "%d GiB", $2/1048576}' /proc/meminfo)}
TWO_NODES=0; [ -n "${SLOTS_B:-}" ] && TWO_NODES=1
extra=(-e "SLOTS=$(( ${SLOTS_A:-0} + ${SLOTS_B:-0} ))" -e "POOL=$(( ${POOL_A:-0} + ${POOL_B:-0} ))"
  -e "TWO_NODES=$TWO_NODES" -e "RUNTIME_A=${RUNTIME_A:-docker}" -e "MICROVM_RECORDING=${MICROVM_RECORDING:-vm}"
  -e "MICROVM_PROFILES=${MICROVM_PROFILES:-vm}")
for kv in "$@"; do extra+=(-e "$kv"); done

# The node agents' probe controls, as deploy.sh composes them.
COMPOSE=(docker compose --env-file /var/lib/kestrel/compose.env -f infra/compose/docker-compose.yml)
[ "${RUNTIME_A:-docker}" = microvm ] && COMPOSE+=(-f infra/compose/docker-compose.microvm.yml)
[ "${KESTREL_MODE:-public}" = local ] && COMPOSE+=(-f infra/compose/docker-compose.local.yml)
AGENTS=(node-a); SOCKETS=(/run/kestrel/a/harness.sock)
if [ "$TWO_NODES" = 1 ]; then COMPOSE+=(--profile b); AGENTS+=(node-b); SOCKETS+=(/run/kestrel/b/harness.sock); fi
harness() { # on|off
  if [ "$1" = on ]; then
    # Recreated even if already on: a stale socket from a crash would look like an agent that is ready.
    rm -f "${SOCKETS[@]}"
    KESTREL_HARNESS=on "${COMPOSE[@]}" up -d --no-deps --force-recreate "${AGENTS[@]}" >/dev/null
    for s in "${SOCKETS[@]}"; do
      for _ in $(seq 1 90); do [ -S "$s" ] && break; sleep 1; done
      [ -S "$s" ] || { echo "the node agent's harness socket $s did not appear" >&2; exit 1; }
    done
  else
    KESTREL_HARNESS=off "${COMPOSE[@]}" up -d --no-deps "${AGENTS[@]}" >/dev/null
  fi
}
case "$cmd" in
  m1|m2)
    trap 'harness off || echo "could not turn the harness surface off: run sudo infra/host/deploy.sh --no-build" >&2' EXIT
    harness on ;;
esac

name=kestrel-bench
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --network host -u 0:0 --privileged --pid host --cgroupns host \
  -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/kestrel/secrets:/secrets:ro -v /run/kestrel:/run/kestrel \
  -v /run/xtables.lock:/run/xtables.lock -v /var/lib/kestrel/reports:/reports \
  --mount type=bind,source=/run/netns,target=/run/netns,bind-propagation=rslave \
  -v /data/kestrel-vm:/data/kestrel-vm:ro -v /var/lib/kestrel/profiles:/var/lib/kestrel/profiles:ro \
  -v /usr/bin/docker:/usr/bin/docker:ro -v /usr/libexec/docker/cli-plugins:/usr/libexec/docker/cli-plugins:ro \
  -v /srv/kestrel:/srv/kestrel:ro -v /var/lib/kestrel/compose.env:/var/lib/kestrel/compose.env:ro \
  -e PUBLIC_HOSTNAME="$PUBLIC_HOSTNAME" -e PUBLIC_IP="$PUBLIC_IP" -e API_KEY_FILE=/secrets/harness-api-key \
  -e TEST_PAGE_URL="$TEST_PAGE_URL" -e INSTANCE_TYPE="$INSTANCE_TYPE" -e REPORT_DIR=/reports \
  "${extra[@]}" kestrel-platform:dev node bench/framework/dist/cli.js "$cmd"  >/dev/null
# Follow the logs from the host. The Docker client can drop when a chaos case restarts the daemon,
# so reattach until the harness container itself has exited (v1 plan section 7, "restart Docker").
until [ "$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo exited)" != running ]; do
  docker logs -f "$name" 2>&1 || true
  sleep 2
done
docker logs "$name" 2>&1 | tail -n 3
code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo 1)
docker rm -f "$name" >/dev/null 2>&1 || true
exit "$code"
