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
extra=()
for kv in "$@"; do extra+=(-e "$kv"); done
exec docker run --rm --network host -u 0:0 --cap-add NET_ADMIN --cap-add NET_RAW \
  -v /var/run/docker.sock:/var/run/docker.sock -v /var/lib/kestrel/secrets:/secrets:ro -v /run/kestrel:/run/kestrel \
  -v /run/xtables.lock:/run/xtables.lock -v /var/lib/kestrel/reports:/reports \
  -v /usr/bin/docker:/usr/bin/docker:ro -v /usr/libexec/docker/cli-plugins:/usr/libexec/docker/cli-plugins:ro \
  -v /srv/kestrel:/srv/kestrel:ro -v /var/lib/kestrel/compose.env:/var/lib/kestrel/compose.env:ro \
  -e PUBLIC_HOSTNAME="$PUBLIC_HOSTNAME" -e PUBLIC_IP="$PUBLIC_IP" -e API_KEY_FILE=/secrets/harness-api-key \
  -e TEST_PAGE_URL="$TEST_PAGE_URL" -e INSTANCE_TYPE="$INSTANCE_TYPE" -e REPORT_DIR=/reports \
  "${extra[@]}" kestrel-platform:dev node bench/framework/dist/cli.js "$cmd"
