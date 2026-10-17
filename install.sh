#!/usr/bin/env bash
# Install Kestrel on one x86_64 Linux machine (Ubuntu 22.04/24.04, Debian 12/13 or Amazon Linux 2023).
#
#   curl -fsSLo install.sh https://raw.githubusercontent.com/vedantxn/kestrel/main/install.sh && sudo bash install.sh --local
#
# (Download, then run: piped into bash, a failed download still ends with status 0.)
#
# Choose where clients reach it (one of):
#   --local [--address A] [--port P]   local mode: http://A[:P], no TLS, for a trusted network only
#                                      (threat model T-79). A defaults to this machine's LAN address.
#   --hostname H                       public mode: https://H. H must resolve to this machine, and
#                                      ports 80, 443 and 8443 must be reachable from the internet.
#   --sslip                            public mode on <public ip with dashes>.sslip.io (no domain needed).
# Options:
#   --runtime auto|docker|microvm      default auto: microVMs when /dev/kvm works and there is room
#   --version REF                      a release tag or branch (default: main)
#   --build-local                      build the images here instead of pulling them
#   --data-device DEV | --data-size GIB | --no-quota   where /data lives (see prepare-host.sh);
#                                      default: an existing /data mount, else an image on the root disk
#   --take-over-docker                 proceed although Docker already holds containers or images
#   --insecure-public                  allow local mode on an address that is not private
#   --dir DIR                          where the source goes (default /srv/kestrel)
# Capacity: sized for the machine on the first install (about one browser per 2 GB after 6 GB for
# the platform, at most two per CPU), then kept. To choose it: sudo SLOTS_A=20 POOL_A=5 bash install.sh ...
#
# Re-running it is safe: it updates the source to REF and deploys again, keeping data and keys.
set -euo pipefail

REPO=${KESTREL_REPO:-https://github.com/vedantxn/kestrel.git}
VERSION=main; VERSION_GIVEN=0
DIR=/srv/kestrel; DIR_GIVEN=0
MODE=""; ADDRESS=""; PORT=""; HOST=""; RUNTIME=auto; BUILD_LOCAL=0
DATA_ARGS=(); TAKE_OVER=0; INSECURE_PUBLIC=0
while [ $# -gt 0 ]; do
  case "$1" in
    --local) MODE=local; shift;;
    --address) ADDRESS=$2; shift 2;;
    --port) PORT=$2; shift 2;;
    --hostname) MODE=public; HOST=$2; shift 2;;
    --sslip) MODE=sslip; shift;;
    --runtime) RUNTIME=$2; shift 2;;
    --version) VERSION=$2; VERSION_GIVEN=1; shift 2;;
    --build-local) BUILD_LOCAL=1; shift;;
    --data-device|--data-size) DATA_ARGS+=("$1" "$2"); shift 2;;
    --no-quota) DATA_ARGS+=(--no-quota); shift;;
    --take-over-docker) TAKE_OVER=1; shift;;
    --insecure-public) INSECURE_PUBLIC=1; shift;;
    --dir) DIR=$2; DIR_GIVEN=1; shift 2;;
    -h|--help) awk 'NR > 1 && !/^#/ {exit} NR > 1' "$0" 2>/dev/null || echo "see https://github.com/vedantxn/kestrel#install"; exit 0;;
    *) echo "unknown option $1 (try --help)" >&2; exit 2;;
  esac
done
[ -n "$MODE" ] || { echo "choose --local, --hostname H or --sslip (try --help)" >&2; exit 2; }
case "$RUNTIME" in auto|docker|microvm) ;; *) echo "--runtime is auto, docker or microvm" >&2; exit 2;; esac

say() { printf '\n== %s\n' "$*"; }
problems=()
need() { problems+=("$1"); }

# --- preflight: read only, every problem reported at once --------------------------------------
say "checking this machine"
[ "$(id -u)" = 0 ] || need "run as root (sudo)"
[ "$(uname -m)" = x86_64 ] || need "$(uname -m) is not supported: Kestrel's images and Chrome for Testing are x86_64 only"
[ -d /run/systemd/system ] || need "systemd is not running"
if grep -qi microsoft /proc/version 2>/dev/null; then need "WSL is not supported: use a Linux VM or server"; fi
if command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container >/dev/null 2>&1; then
  need "this is a container ($(systemd-detect-virt --container)): Kestrel needs a VM or a real machine"
fi
# Read in a subshell and keep three fields: os-release also sets VERSION, which would replace --version.
# shellcheck disable=SC1091
eval "$(. /etc/os-release 2>/dev/null; printf 'OS_ID=%q OS_VERSION_ID=%q OS_NAME=%q' "${ID:-}" "${VERSION_ID:-}" "${PRETTY_NAME:-}")"
case "$OS_ID:$OS_VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13|amzn:2023) ;;
  *) need "${OS_NAME:-this OS} is untested: use Ubuntu 22.04/24.04, Debian 12/13 or Amazon Linux 2023";;
esac
kernel=$(uname -r | cut -d. -f1-2)
[ "$(printf '%s\n5.15\n' "$kernel" | sort -V | head -1)" = 5.15 ] || need "kernel $kernel is older than 5.15"
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ] || need "cgroup v2 is not in use"
cpus=$(nproc)
mem_gib=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
[ "$cpus" -ge 4 ] || need "$cpus CPUs: at least 4 are needed"
[ "$mem_gib" -ge 7 ] || need "${mem_gib} GiB of memory: at least 8 GiB is needed"
root_free=$(df --output=avail -B1G / | tail -1 | tr -d ' ')

# Ports: Caddy's, the gateway's, and the platform's own loopback listeners.
case "$MODE" in local) web_ports=("${PORT:-80}");; *) web_ports=(80 443);; esac
for p in "${web_ports[@]}" 8443 8080 8081 3000 5432 7001 7201 7301; do
  if command -v ss >/dev/null && ss -Hltn "sport = :$p" 2>/dev/null | grep -q .; then
    # A previous Kestrel install holds them; that is fine.
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^kestrel-' || need "port $p is in use"
  fi
done
case "${PORT:-80}" in 3000|3128|5432|7001|7002|7201|7202|7301|7302|8080|8081|8443|8444) need "--port ${PORT} is used by Kestrel itself";; esac

# Docker already in use for something else: moving its data-root would hide those containers.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  if [ "$root" != /data/docker ] && [ -n "$(docker ps -aq 2>/dev/null)$(docker images -q 2>/dev/null)" ] && [ "$TAKE_OVER" != 1 ]; then
    need "Docker already holds containers or images in $root; Kestrel moves Docker's data to /data/docker, which hides them (pass --take-over-docker to go ahead)"
  fi
fi

# The data volume: an existing /data mount, the option given, or an image on the root disk.
if [ ${#DATA_ARGS[@]} -eq 0 ] && ! mountpoint -q /data 2>/dev/null; then
  size=$(( root_free - 20 )); [ "$size" -gt 60 ] && size=60
  if [ "$size" -ge 20 ]; then DATA_ARGS=(--data-size "$size")
  else need "only ${root_free} GiB free on /: pass --data-device DEV, or --no-quota (recording off)"; fi
fi

# Where clients reach it.
route_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
case "$MODE" in
  local)
    ADDRESS=${ADDRESS:-$route_ip}
    [ -n "$ADDRESS" ] || need "no LAN address found: pass --address"
    PUBLIC_URL="http://$ADDRESS${PORT:+:$PORT}"
    if [ "$INSECURE_PUBLIC" != 1 ] && ! printf '%s' "$ADDRESS" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|127\.)'; then
      need "$ADDRESS is not a private address; local mode sends keys and tokens in cleartext (pass --insecure-public to accept that)"
    fi;;
  public) PUBLIC_URL="https://$HOST";;
  sslip)
    tok=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
    pub=$([ -n "$tok" ] && curl -s -m 2 -f -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
    pub=${pub:-$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '[:space:]' || true)}
    [ -n "$pub" ] || need "could not find this machine's public address: use --hostname"
    PUBLIC_URL="https://${pub//./-}.sslip.io";;
esac

if [ ${#problems[@]} -gt 0 ]; then
  echo "Kestrel cannot be installed here yet:" >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "  ok: x86_64, ${cpus} CPUs, ${mem_gib} GiB, ${OS_NAME:-Linux}, kernel $(uname -r)"
echo "  will serve $PUBLIC_URL"

# --- the source ----------------------------------------------------------------------------------
# Run from a checkout (./install.sh), it installs that tree as it is; piped from curl, it fetches REF.
self=$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)
if [ "$VERSION_GIVEN" = 0 ] && [ "$DIR_GIVEN" = 0 ] && [ -n "$self" ] && [ -f "$self/infra/host/deploy.sh" ]; then
  DIR=$self
  VERSION=$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo main)
  say "the source: this tree ($DIR)"
else
  say "the source ($VERSION)"
  if ! command -v git >/dev/null; then
    if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git >/dev/null; else dnf install -y -q git >/dev/null; fi
  fi
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch -q --depth 1 origin "$VERSION"
    git -C "$DIR" checkout -q --force FETCH_HEAD
  else
    [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || { echo "$DIR exists and is not a git checkout; pass --dir" >&2; exit 1; }
    git clone -q --depth 1 --branch "$VERSION" "$REPO" "$DIR"
  fi
  echo "  $(git -C "$DIR" log -1 --format='%h %s')"
fi

# --- the host, then the platform -----------------------------------------------------------------
say "preparing the host"
"$DIR/infra/host/prepare-host.sh" "${DATA_ARGS[@]}"

if [ "$RUNTIME" = auto ]; then
  data_free=$(df --output=avail -B1G /data | tail -1 | tr -d ' ')
  if [ -c /dev/kvm ] && [ -w /dev/kvm ] && [ "$mem_gib" -ge 15 ] && [ "$data_free" -ge 15 ]; then RUNTIME=microvm; else RUNTIME=docker; fi
  echo "  runtime: $RUNTIME"
fi

say "deploying"
deploy_env=(PUBLIC_URL="$PUBLIC_URL" RUNTIME_A="$RUNTIME")
if [ "$BUILD_LOCAL" != 1 ]; then deploy_env+=(KESTREL_IMAGE_TAG="$VERSION" KESTREL_BUILD_FALLBACK=1); fi
env "${deploy_env[@]}" "$DIR/infra/host/deploy.sh"

cat <<NEXT

Next:
  - Open $PUBLIC_URL and sign in with the admin API key (above on a first install; kept in
    /var/lib/kestrel/secrets/owner-api-key).
  - Make a key for your code on the dashboard's API keys page, then follow
    https://kestrel-browsers.vercel.app/docs/quickstart
  - Check it yourself: $DIR/bin/verify $PUBLIC_URL <api key>
NEXT
