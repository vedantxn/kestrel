#!/usr/bin/env bash
# Deploy the platform on this host from the tree in /srv/kestrel (v1 plan I15, I16). Idempotent.
# Run as root (bin/host deploy and bin/host run do):
#   sudo infra/host/deploy.sh [--no-build] [--two-nodes]
#   RUNTIME_A=microvm: node a's browsers are Firecracker microVMs (ADR 0017); node b stays Docker.
#   MICROVM_RECORDING=docker: node a's recording sessions are Docker containers (the escape hatch);
#   by default they are VMs too, their recordings pulled out (docs/lld/microvm-recording.md).
#
# Builds the images, makes the secrets the first time, starts Postgres, applies migrations,
# creates the first project and API key, then starts the platform services.
set -euo pipefail
NO_BUILD=0; TWO=0
for a in "$@"; do case "$a" in --no-build) NO_BUILD=1;; --two-nodes) TWO=1;; *) echo "unknown option $a" >&2; exit 2;; esac; done
cd "$(dirname "$0")/../.."
SECRETS=/var/lib/kestrel/secrets
COMPOSE=(docker compose --env-file /var/lib/kestrel/compose.env -f infra/compose/docker-compose.yml)
RUNTIME_A=${RUNTIME_A:-docker}
log() { printf '\n== %s\n' "$*"; }

log "host prerequisites"
/usr/local/bin/kestrel-host-check
if [ "$RUNTIME_A" = microvm ]; then
  # Firecracker, the guest kernel, the jailer's cgroup and shared /run/netns, at every boot too.
  infra/host/firecracker-setup.sh
  cat > /etc/systemd/system/kestrel-microvm-host.service <<UNIT
[Unit]
Description=Kestrel microVM host prerequisites (ADR 0017)
Before=docker.service
[Service]
Type=oneshot
ExecStart=$PWD/infra/host/firecracker-setup.sh
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload && systemctl enable kestrel-microvm-host.service >/dev/null 2>&1
  COMPOSE+=(-f infra/compose/docker-compose.microvm.yml)
fi

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
if [ ! -f "$SECRETS/web-session.secret" ]; then head -c 48 /dev/urandom | base64 | tr -d '/+=\n' > "$SECRETS/web-session.secret"; fi
printf 'postgresql://kestrel:%s@127.0.0.1:5432/kestrel' "$(cat "$SECRETS/db.password")" > "$SECRETS/database-url"
# Owners: only what needs a secret can read it. The signing key is the API's alone; the gateways get the public half.
chown 1001:1001 "$SECRETS/database-url" "$SECRETS/node-a.secret" "$SECRETS/node-b.secret" 2>/dev/null || true
chmod 0640 "$SECRETS/node-a.secret" "$SECRETS/node-b.secret"; chmod 0400 "$SECRETS/database-url" "$SECRETS/db.password"
# CAPTCHA solving (docs/lld/captcha.md): the operator puts the service's key in this file by hand;
# it never goes in the repository, an image or Terraform state. Only the API reads it.
if [ -f "$SECRETS/captcha-solver.key" ]; then chown 1001:1001 "$SECRETS/captcha-solver.key"; chmod 0400 "$SECRETS/captcha-solver.key"; fi
# The dashboard (P17) runs as 1002 and reads only the key that seals its sign-in cookies.
chown 1002:1002 "$SECRETS/web-session.secret" 2>/dev/null || true; chmod 0400 "$SECRETS/web-session.secret"
# Profiles (P18, docs/lld/p18-profiles.md 4.5): the master key is made once and never again; losing
# it makes every profile unreadable. Only the API reads it. The store sits on the data volume under
# its own xfs project quota (an id far above the small ones Docker gives recording volumes).
if [ ! -f "$SECRETS/profile-master.key" ]; then head -c 32 /dev/urandom > "$SECRETS/profile-master.key"; fi
chown 1001:1001 "$SECRETS/profile-master.key"; chmod 0400 "$SECRETS/profile-master.key"
install -d -m 0700 -o 1001 -g 0 /var/lib/kestrel/profiles
PROFILE_QUOTA_ID=1000000001
xfs_quota -x -c "project -s -p $(realpath /var/lib/kestrel/profiles) $PROFILE_QUOTA_ID" /data >/dev/null
xfs_quota -x -c "limit -p bhard=${PROFILE_STORE_BYTES:-20g} $PROFILE_QUOTA_ID" /data
chmod 0711 "$SECRETS"; install -d -m 0755 /run/kestrel /var/lib/kestrel/a /var/lib/kestrel/b /var/lib/kestrel/postgres /run/kestrel/a /run/kestrel/b
# /run is emptied by a reboot: have systemd make the runtime directories again at every boot, before
# Docker starts the platform, or the node agent cannot open its sockets and restarts forever.
cat > /etc/tmpfiles.d/kestrel.conf <<'TMPFILES'
d /run/kestrel 0755 root root -
d /run/kestrel/a 0755 root root -
d /run/kestrel/b 0755 root root -
TMPFILES
systemd-tmpfiles --create /etc/tmpfiles.d/kestrel.conf
touch /run/xtables.lock
mkdir -p /var/lib/kestrel/postgres && chown 999:999 /var/lib/kestrel/postgres 2>/dev/null || true

ACCOUNT=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document | sed -n 's/.*"accountId" *: *"\([0-9]*\)".*/\1/p')
TEST_PAGE_URL="https://kestrel-testpage-$ACCOUNT.s3.us-east-1.amazonaws.com/test/index.html"
NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443}]'
SIZES="SLOTS_A=${SLOTS_A:-5}\nPOOL_A=${POOL_A:-2}"
if [ "$TWO" = 1 ]; then
  # Two nodes on one host, to exercise the multi-node paths (sizes: v1 plan 4.12).
  NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443},{"id":"b","address":"http://127.0.0.1:7002","secretFile":"/secrets/node-b.secret","connectPort":8444}]'
  SIZES="SLOTS_A=${SLOTS_A:-3}\nPOOL_A=${POOL_A:-1}\nSLOTS_B=${SLOTS_B:-2}\nPOOL_B=${POOL_B:-1}"
fi
# Pool tuning (optional): warm browsers beyond the slots, and how many to start at once.
SIZES="$SIZES\nPOOL_HEADROOM=${POOL_HEADROOM:-0}\nREFILL_AT_ONCE=${REFILL_AT_ONCE:-}\nRECORDING=${RECORDING:-on}\nREAP_MAX_QUEUE=${REAP_MAX_QUEUE:-4}\nRECORDING_POOL=${RECORDING_POOL:-1}"
# The solver service and URL persist across deploys unless given again (CAPTCHA_SOLVER=none turns it off).
prev() { sed -n "s/^$1=//p" /var/lib/kestrel/compose.env 2>/dev/null | tail -n 1; }
CAPTCHA_SOLVER=${CAPTCHA_SOLVER-$(prev CAPTCHA_SOLVER)}
CAPTCHA_SOLVER_URL=${CAPTCHA_SOLVER_URL-$(prev CAPTCHA_SOLVER_URL)}
if [ "$CAPTCHA_SOLVER" = none ]; then CAPTCHA_SOLVER=; CAPTCHA_SOLVER_URL=; fi
if [ -n "$CAPTCHA_SOLVER" ] && [ ! -s "$SECRETS/captcha-solver.key" ]; then
  echo "CAPTCHA_SOLVER is $CAPTCHA_SOLVER but $SECRETS/captcha-solver.key is missing or empty" >&2; exit 1
fi
cat > /var/lib/kestrel/compose.env <<ENV
PUBLIC_HOSTNAME=$HOSTNAME_PUBLIC
PUBLIC_IP=$PUBLIC_IP
TEST_PAGE_URL=$TEST_PAGE_URL
KESTREL_NODES=$NODES
CAPTCHA_SOLVER=$CAPTCHA_SOLVER
CAPTCHA_SOLVER_URL=$CAPTCHA_SOLVER_URL
ENV
printf "$SIZES\nRUNTIME_A=$RUNTIME_A\nMICROVM_NETNS_READY=${MICROVM_NETNS_READY:-8}\nMICROVM_RECORDING=${MICROVM_RECORDING:-vm}\nMICROVM_PROFILES=${MICROVM_PROFILES:-vm}\n" >> /var/lib/kestrel/compose.env
# Profiles: the node agents tell the API the pinned runtime's Chrome (its major gates which profiles they open).
printf "CHROME_VERSION=%s\n" "$(tr -d '[:space:]' < runtime/CHROME_VERSION)" >> /var/lib/kestrel/compose.env
chmod 0600 /var/lib/kestrel/compose.env

if [ "$NO_BUILD" != 1 ]; then
  log "build the platform image"
  docker build -q -f infra/compose/Dockerfile -t kestrel-platform:dev . >/dev/null
  if ! docker image inspect kestrel-runtime:dev >/dev/null 2>&1; then
    echo "kestrel-runtime:dev is missing; build it with runtime/build.sh" >&2; exit 1
  fi
fi
if [ "$NO_BUILD" != 1 ]; then
  # Every build leaves the previous images untagged, and nothing removed them: 58 of them, 32 GB,
  # had filled the data volume to 95% on 2026-10-07, when a template snapshot no longer fit (its
  # Firecracker call answered 400). Untagged images no container uses go; a running or pooled
  # browser's image stays.
  docker image prune -f >/dev/null
fi
if [ "$RUNTIME_A" = microvm ] && { [ "$NO_BUILD" != 1 ] || [ ! -f /data/kestrel-vm/template/mem ] || [ ! -f /data/kestrel-vm/template-warm/mem ]; }; then
  # Each template is a 2 GiB memory snapshot plus its state; say so plainly rather than let
  # Firecracker fail the snapshot with a bare 400.
  free_gib=$(df --output=avail -B1G /data | tail -1 | tr -d ' ')
  if [ "$free_gib" -lt 6 ]; then
    echo "only ${free_gib} GiB free on /data: the microVM templates need about 6 GiB (docker system df shows what to remove)" >&2; exit 1
  fi
  log "microVM templates (the runtime image, booted once and snapshotted; warm: before Chrome starts, for profiles)"
  runtime/microvm/build-rootfs.sh
  runtime/microvm/build-template.sh
  TEMPLATE=warm runtime/microvm/build-template.sh
fi

if [ ! -f "$SECRETS/token-private.pem" ]; then
  log "token signing keys"
  docker run --rm -v "$SECRETS:/secrets" -u 0:0 kestrel-platform:dev node apps/api/dist/admin.js keygen --dir /secrets
fi
chown 1001:1001 "$SECRETS/token-private.pem"; chmod 0400 "$SECRETS/token-private.pem"; chmod 0644 "$SECRETS/token-public.pem"

# The session network and its address must exist before the egress gateway can listen on it.
# Docker allocates containers' addresses from the lower half; microVMs use the upper (ADR 0017).
session_net() { # NAME OCTET
  local range
  range=$(docker network inspect -f '{{range .IPAM.Config}}{{.IPRange}}{{end}}' "$1" 2>/dev/null || echo missing)
  if [ "$range" != "172.30.$2.0/25" ] && [ "$range" != missing ]; then
    if [ -z "$(docker network inspect -f '{{range .Containers}}x{{end}}' "$1")" ]; then
      docker network rm "$1" >/dev/null; range=missing
    else
      echo "$1 has no IP range and still has containers; stop them to move it" >&2
    fi
  fi
  if [ "$range" = missing ]; then
    docker network create --internal --driver bridge --opt com.docker.network.bridge.name="$1" \
      --opt com.docker.network.bridge.enable_icc=false --subnet "172.30.$2.0/24" --ip-range "172.30.$2.0/25" \
      --gateway "172.30.$2.1" --label kestrel.node="${1#ksl-}" "$1" >/dev/null
  fi
}
session_net ksl-a 1
if [ "$TWO" = 1 ]; then session_net ksl-b 2; fi

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
SERVICES=(api egress-a node-a gateway-a web)
if [ "$TWO" = 1 ]; then SERVICES+=(egress-b node-b gateway-b); COMPOSE=("${COMPOSE[@]}" --profile b); fi
"${COMPOSE[@]}" up -d --remove-orphans "${SERVICES[@]}"
if [ "$TWO" = 0 ]; then
  # Going back to one node: node b's services and anything it left (sessions, pool, recording
  # volumes) go too, or they would sit unreaped with no agent to own them.
  docker rm -f kestrel-egress-b-1 kestrel-node-b-1 kestrel-gateway-b-1 >/dev/null 2>&1 || true
  docker ps -aq --filter label=kestrel.node=b | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter label=kestrel.node=b | xargs -r docker volume rm -f >/dev/null
fi
# P17: a host made before the dashboard answers everything outside the API with a placeholder
# (Terraform does not re-run the startup script); send it to the dashboard, as a fresh host does.
caddy=/srv/kestrel-boot/Caddyfile
if [ -f "$caddy" ] && grep -q 'respond "kestrel placeholder"' "$caddy"; then
  log "route the dashboard through Caddy"
  sed -i 's#respond "kestrel placeholder" 200#reverse_proxy 127.0.0.1:3000#' "$caddy"
  docker restart kestrel-boot-caddy-1 >/dev/null
fi
sleep 8
"${COMPOSE[@]}" ps
curl -s -m 5 http://127.0.0.1:8080/healthz && echo
echo "deployed https://$HOSTNAME_PUBLIC"
