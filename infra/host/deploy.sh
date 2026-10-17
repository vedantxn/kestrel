#!/usr/bin/env bash
# Deploy the platform on this host from the tree it sits in (v1 plan I15, I16). Idempotent.
# Run as root, after infra/host/prepare-host.sh (install.sh runs both):
#   sudo infra/host/deploy.sh [--no-build] [--two-nodes]
#   PUBLIC_URL=https://<host> | http://<address>[:port]   where clients reach it; http:// is local
#     mode (no TLS, trusted networks only: threat model T-79). Kept from the last deploy when unset;
#     on AWS it defaults to https://<public ip with dashes>.sslip.io.
#   KESTREL_IMAGE_TAG=<tag>: pull <KESTREL_IMAGE_REPO>/kestrel-{platform,runtime}:<tag> (default
#     repository ghcr.io/vedantxn) instead of building the images here.
#   RUNTIME_A=microvm: node a's browsers are Firecracker microVMs (ADR 0017); node b stays Docker.
#   MICROVM_RECORDING=docker: node a's recording sessions are Docker containers (the escape hatch);
#   by default they are VMs too, their recordings pulled out (docs/lld/microvm-recording.md).
#   SLOTS_A=<n> POOL_A=<n>: node a's browsers at once, and how many it keeps ready. The first deploy
#     sizes them for the machine; later deploys keep the last values unless given again.
#
# Builds or pulls the images, makes the secrets the first time, starts Postgres, applies migrations,
# creates the first project and API keys, starts the platform services and makes one session.
set -euo pipefail
NO_BUILD=0; TWO=0
for a in "$@"; do case "$a" in --no-build) NO_BUILD=1;; --two-nodes) TWO=1;; *) echo "unknown option $a" >&2; exit 2;; esac; done
cd "$(dirname "$0")/../.."
SECRETS=/var/lib/kestrel/secrets
COMPOSE=(docker compose --env-file /var/lib/kestrel/compose.env -f infra/compose/docker-compose.yml)
log() { printf '\n== %s\n' "$*"; }
# A setting from the last deploy, or nothing on the first (no file: pipefail must not end the script).
prev() { [ -f /var/lib/kestrel/compose.env ] || return 0; sed -n "s/^$1=//p" /var/lib/kestrel/compose.env | tail -n 1; }
# shellcheck disable=SC1091
[ -f /etc/kestrel/host.env ] && . /etc/kestrel/host.env
KESTREL_QUOTA=${KESTREL_QUOTA:-on}
# Node a's runtime: as given, else as last deployed, else Docker.
RUNTIME_A=${RUNTIME_A:-$(prev RUNTIME_A)}
RUNTIME_A=${RUNTIME_A:-docker}

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

# Where clients reach the platform. On AWS the instance's metadata gives the public address
# (a token is required); elsewhere PUBLIC_URL must be given once, and is kept after that.
imds() {
  local tok
  tok=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  if [ -n "$tok" ]; then curl -s -m 2 -f -H "X-aws-ec2-metadata-token: $tok" "http://169.254.169.254/latest/$1" || true; fi
}
AWS_PUBLIC_IP=$(imds meta-data/public-ipv4)
PUBLIC_URL=${PUBLIC_URL:-${PUBLIC_HOSTNAME:+https://$PUBLIC_HOSTNAME}}
PUBLIC_URL=${PUBLIC_URL:-$(prev PUBLIC_URL)}
if [ -z "$PUBLIC_URL" ] && [ -n "$(prev PUBLIC_HOSTNAME)" ]; then PUBLIC_URL="https://$(prev PUBLIC_HOSTNAME)"; fi
if [ -z "$PUBLIC_URL" ] && [ -n "$AWS_PUBLIC_IP" ]; then PUBLIC_URL="https://${AWS_PUBLIC_IP//./-}.sslip.io"; fi
[ -n "$PUBLIC_URL" ] || { echo "set PUBLIC_URL, e.g. https://kestrel.example.com, or http://192.168.1.10 for local mode" >&2; exit 2; }
PUBLIC_URL=${PUBLIC_URL%/}
case "$PUBLIC_URL" in
  https://*) KESTREL_MODE=public;;
  http://*) KESTREL_MODE=local;;
  *) echo "PUBLIC_URL must start with https:// or http://: $PUBLIC_URL" >&2; exit 2;;
esac
hostport=${PUBLIC_URL#*://}
case "$hostport" in */*|*@*) echo "PUBLIC_URL must have no path or user info: $PUBLIC_URL" >&2; exit 2;; esac
case "$hostport" in
  \[*) HOSTNAME_PUBLIC="${hostport%%]*}]";;
  *) HOSTNAME_PUBLIC=${hostport%%:*};;
esac
port=${hostport#"$HOSTNAME_PUBLIC"}; port=${port#:}
if [ "$KESTREL_MODE" = public ]; then
  [ -z "$port" ] || { echo "a public (https://) URL is served on port 443; drop :$port" >&2; exit 2; }
  CADDY_SITE=$HOSTNAME_PUBLIC
else
  CADDY_SITE="http://:${port:-80}"
  COMPOSE+=(-f infra/compose/docker-compose.local.yml)
fi
# The host's own addresses, which no session may reach (the egress gateway's BLOCKED_ADDRESSES):
# the public one, the one the URL resolves to, and the one on the default route (the LAN's).
ROUTE_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
RESOLVED_IP=$(getent ahostsv4 "$HOSTNAME_PUBLIC" 2>/dev/null | awk 'NR==1 {print $1}' || true)
PUBLIC_IP=${AWS_PUBLIC_IP:-${RESOLVED_IP:-$ROUTE_IP}}
BLOCKED=$(printf '%s\n' "$AWS_PUBLIC_IP" "$RESOLVED_IP" "$ROUTE_IP" | grep -v '^$' | grep -v '^127\.' | sort -u | paste -sd, - || true)

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
if [ "$KESTREL_QUOTA" = on ]; then
  PROFILE_QUOTA_ID=1000000001
  xfs_quota -x -c "project -s -p $(realpath /var/lib/kestrel/profiles) $PROFILE_QUOTA_ID" /data >/dev/null
  xfs_quota -x -c "limit -p bhard=${PROFILE_STORE_BYTES:-20g} $PROFILE_QUOTA_ID" /data
else
  # Without project quotas a recording volume has no size limit, so recording is off (v1 plan section 8).
  echo "KESTREL_QUOTA=off: recording is off, and the profile store has no size limit"
  RECORDING=off
fi
chmod 0711 "$SECRETS"; install -d -m 0755 /run/kestrel /var/lib/kestrel/a /var/lib/kestrel/b /var/lib/kestrel/postgres /run/kestrel/a /run/kestrel/b
# /run is emptied by a reboot: have systemd make the runtime directories again at every boot, before
# Docker starts the platform, or the node agent cannot open its sockets and restarts forever.
cat > /etc/tmpfiles.d/kestrel.conf <<'TMPFILES'
d /run/kestrel 0755 root root -
d /run/kestrel/a 0755 root root -
d /run/kestrel/b 0755 root root -
f /run/xtables.lock 0600 root root -
TMPFILES
# The node agents share iptables' lock with the host by mounting /run/xtables.lock. It must exist
# before they start, every boot (the tmpfiles line above): missing, Docker makes a directory in its
# place and the agent cannot start. Amazon Linux makes it at boot anyway; Ubuntu does not.
if [ -d /run/xtables.lock ]; then rmdir /run/xtables.lock; fi
systemd-tmpfiles --create /etc/tmpfiles.d/kestrel.conf
mkdir -p /var/lib/kestrel/postgres && chown 999:999 /var/lib/kestrel/postgres 2>/dev/null || true

# The harness's public test page (bench only): Terraform's S3 bucket on AWS, else none unless given.
TEST_PAGE_URL=${TEST_PAGE_URL:-$(prev TEST_PAGE_URL)}
if [ -z "$TEST_PAGE_URL" ]; then
  ACCOUNT=$(imds dynamic/instance-identity/document | sed -n 's/.*"accountId" *: *"\([0-9]*\)".*/\1/p')
  REGION=$(imds meta-data/placement/region)
  if [ -n "$ACCOUNT" ]; then TEST_PAGE_URL="https://kestrel-testpage-$ACCOUNT.s3.${REGION:-us-east-1}.amazonaws.com/test/index.html"; fi
fi
NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443}]'
# Sizes: as given, else as last deployed with the same nodes, else the defaults below. A re-run
# (an upgrade) must not quietly put a host sized by hand back to the defaults.
TOPOLOGY=one; [ "$TWO" = 1 ] && TOPOLOGY=two
kept() { [ "$(prev TOPOLOGY)" = "$TOPOLOGY" ] && prev "$1"; return 0; }
SLOTS_A=${SLOTS_A:-$(kept SLOTS_A)}; POOL_A=${POOL_A:-$(kept POOL_A)}
if [ "$TWO" = 1 ]; then
  # Two nodes on one host, to exercise the multi-node paths (sizes: v1 plan 4.12).
  NODES='[{"id":"a","address":"http://127.0.0.1:7001","secretFile":"/secrets/node-a.secret","connectPort":8443},{"id":"b","address":"http://127.0.0.1:7002","secretFile":"/secrets/node-b.secret","connectPort":8444}]'
  SLOTS_B=${SLOTS_B:-$(kept SLOTS_B)}; POOL_B=${POOL_B:-$(kept POOL_B)}
  SIZES="SLOTS_A=${SLOTS_A:-3}\nPOOL_A=${POOL_A:-1}\nSLOTS_B=${SLOTS_B:-2}\nPOOL_B=${POOL_B:-1}"
else
  # One node sized for this machine (HLD 10): a slot per 2 GB after 6 GB for the platform, at most
  # two per CPU (2:1 overcommit), at least 2; a pool of a quarter of the slots, at least 2. MemTotal
  # is a little under the machine's size; kB / 10^6 lands on it (16 GB -> 16, so 5 slots as before).
  mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1000000}' /proc/meminfo)
  fit=$(( (mem_gb - 6) / 2 )); [ "$fit" -gt $(( 2 * $(nproc) )) ] && fit=$(( 2 * $(nproc) ))
  [ "$fit" -lt 2 ] && fit=2
  pool=$(( ${SLOTS_A:-$fit} / 4 )); [ "$pool" -lt 2 ] && pool=2
  SLOTS_A=${SLOTS_A:-$fit}; POOL_A=${POOL_A:-$pool}
  echo "node a: $SLOTS_A slots, pool $POOL_A (sized for ${mem_gb} GB and $(nproc) CPUs: $fit; override with SLOTS_A / POOL_A)"
  SIZES="SLOTS_A=$SLOTS_A\nPOOL_A=$POOL_A"
fi
# Pool tuning (optional): warm browsers beyond the slots, and how many to start at once.
POOL_HEADROOM=${POOL_HEADROOM:-$(kept POOL_HEADROOM)}; REFILL_AT_ONCE=${REFILL_AT_ONCE:-$(kept REFILL_AT_ONCE)}
REAP_MAX_QUEUE=${REAP_MAX_QUEUE:-$(kept REAP_MAX_QUEUE)}; RECORDING_POOL=${RECORDING_POOL:-$(kept RECORDING_POOL)}
RECORDING=${RECORDING:-$(kept RECORDING)}
SIZES="$SIZES\nPOOL_HEADROOM=${POOL_HEADROOM:-0}\nREFILL_AT_ONCE=${REFILL_AT_ONCE:-}\nRECORDING=${RECORDING:-on}\nREAP_MAX_QUEUE=${REAP_MAX_QUEUE:-4}\nRECORDING_POOL=${RECORDING_POOL:-1}\nTOPOLOGY=$TOPOLOGY"
# The solver service and URL persist across deploys unless given again (CAPTCHA_SOLVER=none turns it off).
CAPTCHA_SOLVER=${CAPTCHA_SOLVER-$(prev CAPTCHA_SOLVER)}
CAPTCHA_SOLVER_URL=${CAPTCHA_SOLVER_URL-$(prev CAPTCHA_SOLVER_URL)}
if [ "$CAPTCHA_SOLVER" = none ]; then CAPTCHA_SOLVER=; CAPTCHA_SOLVER_URL=; fi
if [ -n "$CAPTCHA_SOLVER" ] && [ ! -s "$SECRETS/captcha-solver.key" ]; then
  echo "CAPTCHA_SOLVER is $CAPTCHA_SOLVER but $SECRETS/captcha-solver.key is missing or empty" >&2; exit 1
fi
cat > /var/lib/kestrel/compose.env <<ENV
PUBLIC_URL=$PUBLIC_URL
KESTREL_MODE=$KESTREL_MODE
CADDY_SITE=$CADDY_SITE
PUBLIC_HOSTNAME=$HOSTNAME_PUBLIC
PUBLIC_IP=$PUBLIC_IP
BLOCKED_ADDRESSES=$BLOCKED
TEST_PAGE_URL=$TEST_PAGE_URL
KESTREL_NODES=$NODES
CAPTCHA_SOLVER=$CAPTCHA_SOLVER
CAPTCHA_SOLVER_URL=$CAPTCHA_SOLVER_URL
ENV
printf "$SIZES\nRUNTIME_A=$RUNTIME_A\nMICROVM_NETNS_READY=${MICROVM_NETNS_READY:-8}\nMICROVM_RECORDING=${MICROVM_RECORDING:-vm}\nMICROVM_PROFILES=${MICROVM_PROFILES:-vm}\n" >> /var/lib/kestrel/compose.env
# Profiles: the node agents tell the API the pinned runtime's Chrome (its major gates which profiles they open).
printf "CHROME_VERSION=%s\n" "$(tr -d '[:space:]' < runtime/CHROME_VERSION)" >> /var/lib/kestrel/compose.env
chmod 0600 /var/lib/kestrel/compose.env

PULLED=0
if [ -n "${KESTREL_IMAGE_TAG:-}" ]; then
  # Published images (.github/workflows/images.yml), tagged :dev so everything else is unchanged.
  # KESTREL_BUILD_FALLBACK=1 builds them here when they cannot be pulled.
  repo=${KESTREL_IMAGE_REPO:-ghcr.io/vedantxn}
  log "pull the images ($repo, $KESTREL_IMAGE_TAG)"
  if docker pull -q "$repo/kestrel-platform:$KESTREL_IMAGE_TAG" >/dev/null \
    && docker pull -q "$repo/kestrel-runtime:$KESTREL_IMAGE_TAG" >/dev/null; then
    docker tag "$repo/kestrel-platform:$KESTREL_IMAGE_TAG" kestrel-platform:dev
    docker tag "$repo/kestrel-runtime:$KESTREL_IMAGE_TAG" kestrel-runtime:dev
    PULLED=1
  elif [ "${KESTREL_BUILD_FALLBACK:-0}" = 1 ]; then
    echo "could not pull them; building here instead (about ten minutes)"
    docker image rm kestrel-runtime:dev >/dev/null 2>&1 || true
  else
    echo "could not pull $repo/kestrel-{platform,runtime}:$KESTREL_IMAGE_TAG" >&2; exit 1
  fi
fi
if [ "$PULLED" = 1 ]; then
  :
elif [ "$NO_BUILD" != 1 ]; then
  log "build the platform image"
  docker build -q -f infra/compose/Dockerfile -t kestrel-platform:dev . >/dev/null
  if ! docker image inspect kestrel-runtime:dev >/dev/null 2>&1; then
    log "build the runtime image"
    runtime/build.sh
  fi
fi
if [ "$NO_BUILD" != 1 ]; then
  # Every build leaves the previous images untagged, and nothing removed them: 58 of them, 32 GB,
  # had filled the data volume to 95% on 2026-10-07, when a template snapshot no longer fit (its
  # Firecracker call answered 400). Untagged images no container uses go; a running or pooled
  # browser's image stays.
  docker image prune -f >/dev/null
  # Most of it was BuildKit's cache: each platform build adds its npm install and compile layers
  # (29 GB of cache, all reclaimable). Keep 5 GB so the next build stays quick.
  docker builder prune -f --keep-storage 5gb >/dev/null
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
  # By the exit status alone: Docker 29 prints an empty line for a network that does not exist.
  if ! range=$(docker network inspect -f '{{range .IPAM.Config}}{{.IPRange}}{{end}}' "$1" 2>/dev/null); then range=missing; fi
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
# The operator's key: an admin key (it also sees nodes and can make projects), shown once below.
NEW_OWNER_KEY=""
if [ ! -f "$SECRETS/owner-api-key" ]; then
  "${ADMIN[@]}" create-key --name owner --admin | tail -1 > "$SECRETS/owner-api-key"
  chmod 0600 "$SECRETS/owner-api-key"
  NEW_OWNER_KEY=$(cat "$SECRETS/owner-api-key")
fi

# Caddy used to run as its own compose project, made by the AWS first-boot script; it is part of
# this one now. Its certificates stay in /data/caddy, so none is issued again.
if [ -f /srv/kestrel-boot/compose.yml ]; then
  docker compose -f /srv/kestrel-boot/compose.yml down >/dev/null 2>&1 || true
  rm -rf /srv/kestrel-boot
fi

log "start the platform"
SERVICES=(caddy api egress-a node-a gateway-a web)
if [ "$TWO" = 1 ]; then SERVICES+=(egress-b node-b gateway-b); COMPOSE=("${COMPOSE[@]}" --profile b); fi
"${COMPOSE[@]}" up -d --remove-orphans "${SERVICES[@]}"
if [ "$TWO" = 0 ]; then
  # Going back to one node: node b's services and anything it left (sessions, pool, recording
  # volumes) go too, or they would sit unreaped with no agent to own them.
  docker rm -f kestrel-egress-b-1 kestrel-node-b-1 kestrel-gateway-b-1 >/dev/null 2>&1 || true
  docker ps -aq --filter label=kestrel.node=b | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter label=kestrel.node=b | xargs -r docker volume rm -f >/dev/null
fi

log "smoke test: one session"
for _ in $(seq 1 60); do curl -sf -m 2 http://127.0.0.1:8080/healthz >/dev/null && break; sleep 2; done
KEY=$(cat "$SECRETS/harness-api-key")
# A node agent the deploy just recreated takes a few seconds to answer: retry what the API calls
# retryable, for up to three minutes.
sid=""; connect=""; created=""
for _ in $(seq 1 36); do
  created=$(curl -s -m 120 -X POST http://127.0.0.1:8080/v1/sessions -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' -d '{"waitForCapacityMs":60000}' || true)
  sid=$(printf '%s' "$created" | jq -r '.id // empty' 2>/dev/null || true)
  connect=$(printf '%s' "$created" | jq -r '.connectUrl // empty' 2>/dev/null || true)
  [ -n "$sid" ] && break
  [ "$(printf '%s' "$created" | jq -r '.error.retryable // true' 2>/dev/null)" = true ] || break
  sleep 5
done
if [ -z "$sid" ] || [ -z "$connect" ]; then
  echo "the smoke test could not make a session: $created" >&2
  "${COMPOSE[@]}" ps
  exit 1
fi
curl -s -m 30 -X POST "http://127.0.0.1:8080/v1/sessions/$sid/stop" -H "Authorization: Bearer $KEY" >/dev/null || true
echo "made and stopped $sid"

cat <<DONE

Kestrel is running.
  Dashboard and API:  $PUBLIC_URL
  Browsers (CDP):     ${connect%%/v1/*}
  Runtime:            node a: $RUNTIME_A
DONE
if [ -n "$NEW_OWNER_KEY" ]; then
  printf '  Admin API key:      %s\n                      (shown once; kept in %s)\n' "$NEW_OWNER_KEY" "$SECRETS/owner-api-key"
else
  printf '  Admin API key:      in %s\n' "$SECRETS/owner-api-key"
fi
if [ "$KESTREL_MODE" = local ]; then
  cat <<'WARN'

  LOCAL MODE: no TLS. API keys, tokens and browser traffic cross the network in cleartext.
  Use it only on a network where every device is trusted (threat model T-79).
WARN
fi
