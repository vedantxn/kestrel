#!/usr/bin/env bash
# One-time upgrade of a host provisioned before v2 (Terraform does not re-run the startup script).
# Brings it to what infra/terraform/main/userdata.sh.tpl now makes on a fresh host:
#   - Docker's volumes directory mounted noexec,nosuid,nodev (W3 recordings)
#   - Caddy forwarding /mcp (W7) and /live/* (W2) to the API
# Idempotent. Run as root: `bin/host run -- sudo infra/host/upgrade-v2.sh`.
set -euo pipefail

if ! findmnt -no OPTIONS /data/docker/volumes 2>/dev/null | grep -q noexec; then
  echo "== mounting /data/docker/volumes noexec (stops Docker briefly; live-restore keeps containers)"
  mkdir -p /data/docker/volumes
  grep -q " /data/docker/volumes " /etc/fstab || echo "/data/docker/volumes /data/docker/volumes none bind,noexec,nosuid,nodev,nofail 0 0" >> /etc/fstab
  systemctl stop docker docker.socket
  mount /data/docker/volumes
  systemctl start docker
fi
findmnt -no OPTIONS /data/docker/volumes

caddy=/srv/kestrel-boot/Caddyfile
if ! grep -q '/live/\*' "$caddy"; then
  echo "== adding /mcp and /live/* to Caddy's public paths"
  sed -i -E 's#^(\s*@public path /v1/\*)( /mcp)?( /live/\*)?#\1 /mcp /live/*#' "$caddy"
  docker restart kestrel-boot-caddy-1 >/dev/null
fi
grep -n '@public path' "$caddy"
echo "upgraded"
