#!/usr/bin/env bash
# Deploy the platform on this host from the tree in /srv/kestrel (v1 plan I15, I16). Idempotent.
# Run as root (bin/host deploy and bin/host run do):
#   sudo infra/host/deploy.sh [--no-build] [--two-nodes]
#
# Builds the images, makes the secrets the first time, starts Postgres, applies migrations,
# creates the first project and API key, then starts the platform services.
set -euo pipefail
NO_BUILD=0; TWO=0
for a in "$@"; do case "$a" in --no-build) NO_BUILD=1;; --two-nodes) TWO=1;; *) echo "unknown option $a" >&2; exit 2;; esac; done
cd "$(dirname "$0")/../.."
SECRETS=/var/lib/kestrel/secrets
COMPOSE=(docker compose --env-file /var/lib/kestrel/compose.env -f infra/compose/docker-compose.yml)
log() { printf '\n== %s\n' "$*"; }

log "host prerequisites"
/usr/local/bin/kestrel-host-check

# The hostname and public address come from the instance's own metadata (token required).
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
HOSTNAME_PUBLIC="${PUBLIC_IP//./-}.sslip.io"

log "secrets"
install -d -m 0700 "$SECRETS"
if [ ! -f "$SECRETS/db.password" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$SECRETS/db.password"
fi
if [ ! -f "$SECRETS/node-a.secret" ]; then head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$SECRETS/node-a.secret"; fi
if [ ! -f "$SECRETS/node-b.secret" ]; then head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$SECRETS/node-b.secret"; fi
printf 'postgresql://kestrel:%s@127.0.0.1:5432/kestrel' "$(cat "$SECRETS/db.password")" > "$SECRETS/database-url"
# Owners: only what needs a secret can read it. The signing key is the API's alone; the gateways get the public half.
chown 1001:1001 "$SECRETS/database-url" "$SECRETS/node-a.secret" "$SECRETS/node-b.secret" 2>/dev/null || true
chmod 0640 "$SECRETS/node-a.secret" "$SECRETS/node-b.secret"; chmod 0400 "$SECRETS/database-url" "$SECRETS/db.password"
chmod 0711 "$SECRETS"; install -d -m 0755 /run/kestrel /var/lib/kestrel/a /var/lib/kestrel/b /var/lib/kestrel/postgres /run/kestrel/a /run/kestrel/b
touch /run/xtables.lock
mkdir -p /var/lib/kestrel/postgres && chown 999:999 /var/lib/kestrel/postgres 2>/dev/null || true

ACCOUNT=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | sed -n 's/.*"accountId" *: *"\([0-9]*\)".*/\1/p')
TEST_PAGE_URL="https://kestrel-testpage-$ACCOUNT.s3.us-east-1.amazonaws.com/test/index.html"
NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443}]'
SIZES="SLOTS_A=5\nPOOL_A=2"
if [ "$TWO" = 1 ]; then
  # Two nodes on one host, to exercise the multi-node paths (sizes: v1 plan 4.12).
  NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443},{"id":"b","address":"http://127.0.0.1:7002","secretFile":"/secrets/node-b.secret","connectPort":8444}]'
  SIZES="SLOTS_A=${SLOTS_A:-3}\nPOOL_A=${POOL_A:-1}\nSLOTS_B=${SLOTS_B:-2}\nPOOL_B=${POOL_B:-1}"
fi
cat > /var/lib/kestrel/compose.env <<ENV
PUBLIC_HOSTNAME=$HOSTNAME_PUBLIC
PUBLIC_IP=$PUBLIC_IP
TEST_PAGE_URL=$TEST_PAGE_URL
KESTREL_NODES=$NODES
ENV
printf "$SIZES\n" >> /var/lib/kestrel/compose.env
chmod 0600 /var/lib/kestrel/compose.env

if [ "$NO_BUILD" != 1 ]; then
  log "build the platform image"
  docker build -q -f infra/compose/Dockerfile -t kestrel-platform:dev . >/dev/null
  if ! docker image inspect kestrel-runtime:dev >/dev/null 2>&1; then
    echo "kestrel-runtime:dev is missing; build it with runtime/build.sh" >&2; exit 1
  fi
fi

if [ ! -f "$SECRETS/token-private.pem" ]; then
  log "token signing keys"
  docker run --rm -v "$SECRETS:/secrets" -u 0:0 kestrel-platform:dev node apps/api/dist/admin.js keygen --dir /secrets
fi
chown 1001:1001 "$SECRETS/token-private.pem"; chmod 0400 "$SECRETS/token-private.pem"; chmod 0644 "$SECRETS/token-public.pem"

# The session network and its address must exist before the egress gateway can listen on it.
if ! docker network inspect ksl-a >/dev/null 2>&1; then
  docker network create --internal --driver bridge --opt com.docker.network.bridge.name=ksl-a \
    --opt com.docker.network.bridge.enable_icc=false --subnet 172.30.1.0/24 --gateway 172.30.1.1 --label kestrel.node=a ksl-a >/dev/null
fi

if [ "$TWO" = 1 ] && ! docker network inspect ksl-b >/dev/null 2>&1; then
  docker network create --internal --driver bridge --opt com.docker.network.bridge.name=ksl-b \
    --opt com.docker.network.bridge.enable_icc=false --subnet 172.30.2.0/24 --gateway 172.30.2.1 --label kestrel.node=b ksl-b >/dev/null
fi

log "database"
"${COMPOSE[@]}" up -d postgres
for _ in $(seq 1 60); do "${COMPOSE[@]}" exec -T postgres pg_isready -U kestrel >/dev/null 2>&1 && break; sleep 1; done
DBURL=$(cat "$SECRETS/database-url")
docker run --rm --network host -e DATABASE_URL="$DBURL" -w /app/packages/db kestrel-platform:dev \
  node /app/node_modules/prisma/build/index.js migrate deploy

log "first project and API key"
ADMIN=(docker run --rm --network host -e DATABASE_URL="$DBURL" kestrel-platform:dev node apps/api/dist/admin.js)
"${ADMIN[@]}" bootstrap >/dev/null
if [ ! -f "$SECRETS/harness-api-key" ]; then
  "${ADMIN[@]}" create-key --name harness | tail -1 > "$SECRETS/harness-api-key"
  chmod 0600 "$SECRETS/harness-api-key"
  echo "created the harness API key at $SECRETS/harness-api-key"
fi

log "start the platform"
SERVICES=(api egress-a node-a gateway-a)
if [ "$TWO" = 1 ]; then SERVICES+=(egress-b node-b gateway-b); COMPOSE=("${COMPOSE[@]}" --profile b); fi
"${COMPOSE[@]}" up -d --remove-orphans "${SERVICES[@]}"
sleep 8
"${COMPOSE[@]}" ps
curl -s -m 5 http://127.0.0.1:8080/healthz && echo
echo "deployed https://$HOSTNAME_PUBLIC"
