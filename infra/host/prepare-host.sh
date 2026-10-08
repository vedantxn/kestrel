#!/usr/bin/env bash
# Prepare a Linux host for Kestrel (v1 plan I9-I13, C15): Docker, the data volume, kernel and journal
# settings, and the host check. Idempotent. Run as root, before infra/host/deploy.sh:
#
#   sudo infra/host/prepare-host.sh [--data-device DEV | --data-size GIB | --no-quota] [--user NAME]
#
#   --data-device DEV  format DEV as xfs (only if it is blank) and mount it at /data with project
#                      quotas. The AWS first-boot script passes the EBS data volume.
#   --data-size GIB    no spare disk: make an xfs image of GIB GiB on the root disk, mounted at /data.
#   --no-quota         neither: /data is a plain directory. Recording is then off (its per-session
#                      size limit is an xfs project quota) and the profile store has no size limit.
#   --user NAME        add NAME to the docker group.
#
# With none of the first three, an existing /data mount is used as it is, and otherwise this stops.
# Works on Ubuntu 22.04 and 24.04, Debian 12 and 13, and Amazon Linux 2023, on x86_64.
set -euo pipefail

COMPOSE_VERSION=v5.6.0
COMPOSE_SHA256=40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a
DATA_IMAGE=/var/lib/kestrel-data/data.img

DEVICE=""; SIZE=""; NO_QUOTA=0; USER_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-device) DEVICE=$2; shift 2;;
    --data-size) SIZE=$2; shift 2;;
    --no-quota) NO_QUOTA=1; shift;;
    --user) USER_NAME=$2; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
log() { printf '\n== %s\n' "$*"; }
here="$(cd "$(dirname "$0")" && pwd)"

# --- packages and Docker (I9) ----------------------------------------------------------------
log "packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git jq xfsprogs iptables chrony iproute2 >/dev/null
  if ! command -v dockerd >/dev/null; then
    # Docker's own repository: the distributions' docker.io is older than 25.0.5 on some releases.
    . /etc/os-release
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
  fi
elif command -v dnf >/dev/null; then
  dnf install -y -q docker git rsync xfsprogs tmux jq iptables-nft chrony iproute >/dev/null
else
  echo "neither apt-get nor dnf found: install Docker, git, jq, xfsprogs, iptables and chrony yourself" >&2; exit 1
fi

# The Compose version Kestrel is tested with, checked by hash.
if [ "$(docker compose version --short 2>/dev/null)" != "${COMPOSE_VERSION#v}" ]; then
  curl -fsSL -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-x86_64"
  echo "$COMPOSE_SHA256  /tmp/docker-compose" | sha256sum -c - >/dev/null
  install -D -m 0755 /tmp/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
  rm -f /tmp/docker-compose
fi

# --- the data volume (I10) -------------------------------------------------------------------
log "the data volume"
mkdir -p /data
QUOTA=on
fstab_add() { grep -qF "$1" /etc/fstab || echo "$1" >> /etc/fstab; }
if [ -n "$DEVICE" ]; then
  [ -b "$DEVICE" ] || { echo "$DEVICE is not a block device" >&2; exit 1; }
  if ! blkid "$DEVICE" >/dev/null 2>&1; then mkfs.xfs -q -L kestrel-data "$DEVICE"; fi
  [ "$(blkid -s TYPE -o value "$DEVICE")" = xfs ] || { echo "$DEVICE is not xfs; refusing to format a disk that holds data" >&2; exit 1; }
  fstab_add "UUID=$(blkid -s UUID -o value "$DEVICE") /data xfs defaults,noatime,prjquota,nofail 0 2"
elif [ -n "$SIZE" ]; then
  # An image file on the root disk, preallocated so the disk cannot run out under it.
  if [ ! -f "$DATA_IMAGE" ]; then
    avail=$(df --output=avail -B1G "$(dirname "$(dirname "$DATA_IMAGE")")" | tail -1 | tr -d ' ')
    [ "$avail" -gt $((SIZE + 5)) ] || { echo "only ${avail} GiB free: a ${SIZE} GiB data image would leave under 5 GiB" >&2; exit 1; }
    install -d -m 0700 "$(dirname "$DATA_IMAGE")"
    fallocate -l "${SIZE}G" "$DATA_IMAGE"
    mkfs.xfs -q -L kestrel-data "$DATA_IMAGE"
  fi
  fstab_add "$DATA_IMAGE /data xfs loop,defaults,noatime,prjquota,nofail 0 2"
elif [ "$NO_QUOTA" = 1 ]; then
  QUOTA=off
elif ! mountpoint -q /data; then
  echo "no data volume: pass --data-device, --data-size or --no-quota" >&2; exit 2
fi
if [ "$QUOTA" = on ]; then
  mountpoint -q /data || mount /data
  findmnt -no OPTIONS /data | grep -Eq '(prjquota|pquota)' || { echo "/data is mounted without project quotas" >&2; exit 1; }
fi
mkdir -p /data/docker/volumes /data/kestrel /data/caddy
ln -sfn /data/kestrel /var/lib/kestrel
# Recording volumes (W3) are written by untrusted containers: Docker's volumes directory is noexec and
# nosuid (not nodev: Docker checks quota support with a device node there). Before Docker starts.
fstab_add "/data/docker/volumes /data/docker/volumes none bind,noexec,nosuid,nofail 0 0"
mountpoint -q /data/docker/volumes || mount /data/docker/volumes
mkdir -p /srv/kestrel /run/kestrel /etc/kestrel
printf 'KESTREL_QUOTA=%s\n' "$QUOTA" > /etc/kestrel/host.env

# --- kernel and journal (C15, threat model G-21) ---------------------------------------------
log "kernel and journal settings"
cat > /etc/sysctl.d/90-kestrel.conf <<'SYSCTL'
fs.inotify.max_user_instances = 1024
fs.inotify.max_user_watches = 524288
user.max_user_namespaces = 63000
SYSCTL
sysctl --system >/dev/null
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/kestrel.conf <<'JOURNALD'
[Journal]
Storage=persistent
SystemMaxUse=1G
SystemKeepFree=2G
RateLimitIntervalSec=30s
RateLimitBurst=5000
JOURNALD
systemctl restart systemd-journald

# --- Docker's settings (I12) -----------------------------------------------------------------
log "Docker"
mkdir -p /etc/docker /etc/systemd/system/docker.service.d
cat > /etc/docker/daemon.json <<'DAEMON'
{
  "data-root": "/data/docker",
  "live-restore": true,
  "log-driver": "journald",
  "log-opts": { "mode": "non-blocking", "max-buffer-size": "4m" }
}
DAEMON
# Docker must not start before /data is mounted, or it writes its data to the root disk underneath.
cat > /etc/systemd/system/docker.service.d/kestrel.conf <<'DROPIN'
[Unit]
RequiresMountsFor=/data /data/docker/volumes
DROPIN
systemctl daemon-reload
for unit in chrony chronyd; do systemctl enable --now "$unit" >/dev/null 2>&1 && break; done || true
systemctl enable docker >/dev/null 2>&1
systemctl restart docker
if [ -n "$USER_NAME" ]; then usermod -aG docker "$USER_NAME" || true; fi

# --- the host check (C15) --------------------------------------------------------------------
install -m 0755 "$here/host-check.sh" /usr/local/bin/kestrel-host-check
log "host check"
/usr/local/bin/kestrel-host-check
