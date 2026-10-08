#!/bin/bash
# First-boot preparation of the Kestrel host (v1 plan I9-I13, C15). Run once by cloud-init as root.
# The work is infra/host/prepare-host.sh, embedded here with the host check it installs; the same
# script prepares a host anywhere else (install.sh). Idempotent, so safe to run again by hand.
set -euo pipefail
exec > >(tee -a /var/log/kestrel-bootstrap.log) 2>&1
echo "== kestrel bootstrap $(date -u +%FT%TZ)"

install -d /usr/local/lib/kestrel
cat > /usr/local/lib/kestrel/host-check.sh <<'HOSTCHECK'
${host_check}
HOSTCHECK
cat > /usr/local/lib/kestrel/prepare-host.sh <<'PREPARE'
${prepare_host}
PREPARE
chmod 0755 /usr/local/lib/kestrel/host-check.sh /usr/local/lib/kestrel/prepare-host.sh

# The EBS data volume (I10), by its id.
dev=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${data_volume_id}
for i in $(seq 1 60); do [ -e "$dev" ] && break; sleep 5; done
[ -e "$dev" ] || { echo "data volume never appeared at $dev"; exit 1; }

/usr/local/lib/kestrel/prepare-host.sh --data-device "$(readlink -f "$dev")" --user ec2-user || true
mkdir -p /var/log/kestrel-run
chown ec2-user:ec2-user /srv/kestrel /var/log/kestrel-run

date -u +%FT%TZ > /var/lib/kestrel/bootstrap-done
echo "== kestrel bootstrap finished"
