#!/bin/bash
# First-boot preparation of the Kestrel host (v1 plan I9-I13, C15). Run once by cloud-init as root.
# Everything here is idempotent, so it is safe to run again by hand.
set -euo pipefail
exec > >(tee -a /var/log/kestrel-bootstrap.log) 2>&1
echo "== kestrel bootstrap $(date -u +%FT%TZ)"

dnf install -y docker git rsync xfsprogs tmux jq iptables-nft chrony

# --- the data volume (I10) -------------------------------------------------------------------
dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${data_volume_id}
for i in $(seq 1 60); do [ -e "$dev" ] && break; sleep 5; done
[ -e "$dev" ] || { echo "data volume never appeared at $dev"; exit 1; }
if ! blkid "$dev" >/dev/null 2>&1; then
  mkfs.xfs -L kestrel-data "$dev"
fi
mkdir -p /data
uuid=$(blkid -s UUID -o value "$dev")
grep -q "$uuid" /etc/fstab || echo "UUID=$uuid /data xfs defaults,noatime,prjquota,nofail 0 2" >> /etc/fstab
mountpoint -q /data || mount /data
mkdir -p /data/docker /data/kestrel /data/caddy /data/docker/volumes
ln -sfn /data/kestrel /var/lib/kestrel
# Recording volumes (W3) are written by untrusted containers: mount Docker's volumes directory
# noexec and nosuid (not nodev: Docker checks quota support with a device node there), which every volume mounted into a container inherits. Before Docker starts.
grep -q " /data/docker/volumes " /etc/fstab || echo "/data/docker/volumes /data/docker/volumes none bind,noexec,nosuid,nofail 0 0" >> /etc/fstab
mountpoint -q /data/docker/volumes || mount /data/docker/volumes
mkdir -p /srv/kestrel /var/log/kestrel-run /run/kestrel
chown ec2-user:ec2-user /srv/kestrel /var/log/kestrel-run

# --- kernel and journal (C15, threat model G-21) ---------------------------------------------
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

# --- Docker (I9, I12) ------------------------------------------------------------------------
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'DAEMON'
{
  "data-root": "/data/docker",
  "live-restore": true,
  "log-driver": "journald",
  "log-opts": { "mode": "non-blocking", "max-buffer-size": "4m" }
}
DAEMON

curl -fsSL -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/${compose_ver}/docker-compose-linux-x86_64"
echo "${compose_sha256}  /tmp/docker-compose" | sha256sum -c -
install -D -m 0755 /tmp/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
rm -f /tmp/docker-compose

systemctl enable --now chronyd
systemctl enable --now docker
usermod -aG docker ec2-user || true

# --- the host check (C15) --------------------------------------------------------------------
cat > /usr/local/bin/kestrel-host-check <<'HOSTCHECK'
${host_check}
HOSTCHECK
chmod 0755 /usr/local/bin/kestrel-host-check

# --- a placeholder Caddy, so the host serves HTTPS before any code is deployed (WP1) ----------
# `bin/host deploy` replaces this with the repository's own compose project.
mkdir -p /srv/kestrel-boot
cat > /srv/kestrel-boot/Caddyfile <<'CADDYFILE'
${hostname} {
	log {
		output stdout
		format filter {
			wrap json
			# Threat model G-01: credentials never reach a log.
			fields {
				request>headers>Authorization delete
				request>headers>X-Api-Key delete
				request>headers>Cookie delete
				request>uri query {
					delete token
				}
			}
		}
	}

	@public path /v1/* /mcp /live/* /healthz /openapi.json
	handle @public {
		reverse_proxy 127.0.0.1:8080
	}
	handle {
		respond "kestrel placeholder" 200
	}
}
CADDYFILE
cat > /srv/kestrel-boot/compose.yml <<'COMPOSE'
name: kestrel-boot
services:
  caddy:
    image: ${caddy_image}
    network_mode: host
    restart: always
    volumes:
      - /srv/kestrel-boot/Caddyfile:/etc/caddy/Caddyfile:ro
      - /data/caddy:/data
COMPOSE
docker compose -f /srv/kestrel-boot/compose.yml up -d

date -u +%FT%TZ > /var/lib/kestrel/bootstrap-done
echo "== kestrel bootstrap finished"
/usr/local/bin/kestrel-host-check || true
