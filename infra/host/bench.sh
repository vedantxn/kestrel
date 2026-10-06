#!/usr/bin/env bash
# Run the exit-check harness on this host, inside the platform image: it needs the Docker socket,
# the secrets, the node's runtime directory and firewall access, because it compares exactly what
# cannot be seen from outside (v1 plan H3). Run as root; `bin/host bench` does.
#   sudo infra/host/bench.sh m1 [VAR=value ...]        QUICK=1 for a short pass
set -euo pipefail
cmd=${1:?usage: bench.sh m1 [VAR=value ...]}; shift
# shellcheck disable=SC1091
set -a; . /var/lib/kestrel/compose.env; set +a
mkdir -p /var/lib/kestrel/reports
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
INSTANCE_TYPE=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-type)
extra=(-e "SLOTS=$(( ${SLOTS_A:-0} + ${SLOTS_B:-0} ))" -e "POOL=$(( ${POOL_A:-0} + ${POOL_B:-0} ))" -e "RUNTIME_A=${RUNTIME_A:-docker}")
for kv in "$@"; do extra+=(-e "$kv"); done
name=kestrel-bench
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --network host -u 0:0 --cap-add NET_ADMIN --cap-add NET_RAW \
  -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/kestrel/secrets:/secrets:ro -v /run/kestrel:/run/kestrel \
  -v /run/xtables.lock:/run/xtables.lock -v /var/lib/kestrel/reports:/reports \
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
