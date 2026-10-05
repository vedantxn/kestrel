#!/usr/bin/env bash
# The microVM template (V7, ADR 0017): one browser booted with runtimed, Xvfb and Chrome running and
# its window sized, then snapshotted. Every session's VM on this host is restored from it. Run as
# root on the host, after infra/host/firecracker-setup.sh and runtime/microvm/build-rootfs.sh:
#   sudo runtime/microvm/build-template.sh
# Writes $DIR/template/{vmstate,mem,rootfs.ext4,token}. The token is the template's control token,
# the same in every clone until the agent replaces it (POST /rekey); it is made here, kept 0600, and
# never leaves the host. Running clones keep the old files (hard links), so this can run any time.
set -euo pipefail
DIR=${MICROVM_DIR:-/data/kestrel-vm}
FC=${FIRECRACKER_DIR:-/opt/firecracker}
VMUID=${MICROVM_UID:-10002}
CGROUP=${MICROVM_CGROUP:-kestrel-vm}
NS=kvm-tpl
ID=tpl-$(date +%s)
NEW=$DIR/template.new
ROOT=$DIR/jail/firecracker/$ID/root
TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
GUEST=172.16.0.2
BOOT="console=ttyS0 reboot=k panic=1 pci=off quiet ro init=/init ip=$GUEST::172.16.0.1:255.255.255.0::eth0:off KESTREL_CONTROL_TOKEN=$TOKEN KESTREL_PROXY=http://172.16.0.1:3128"

cleanup() {
  [ -f "$ROOT/firecracker.pid" ] && kill -9 "$(cat "$ROOT/firecracker.pid")" 2>/dev/null || true
  sleep 0.2
  rm -rf "$DIR/jail/firecracker/$ID" "$NEW"
  rmdir "/sys/fs/cgroup/$CGROUP/$ID" 2>/dev/null || true
  ip netns del $NS 2>/dev/null || true
  ip link del kvtpl 2>/dev/null || true
}
trap cleanup EXIT
[ -f "$DIR/rootfs.ext4" ] || { echo "no $DIR/rootfs.ext4: run runtime/microvm/build-rootfs.sh" >&2; exit 1; }
cp -f "$FC/vmlinux" "$DIR/vmlinux"   # same filesystem as the jail, so it can be linked in
ip netns del $NS 2>/dev/null || true; ip link del kvtpl 2>/dev/null || true
rm -rf "$NEW"; mkdir -p "$NEW" "$DIR/jail"

# The template's network: like a clone's, but reached from the host on a link of its own.
ip netns add $NS
ip link add kvtpl type veth peer name eth0 netns $NS
ip addr add 10.200.255.1/30 dev kvtpl && ip link set kvtpl up
ip -n $NS link set lo up
ip -n $NS addr add 10.200.255.2/30 dev eth0 && ip -n $NS link set eth0 up
ip -n $NS tuntap add tap0 mode tap user "$VMUID" group "$VMUID"
ip -n $NS addr add 172.16.0.1/24 dev tap0 && ip -n $NS link set tap0 up
ip netns exec $NS sysctl -qw net.ipv4.ip_forward=1
ip netns exec $NS iptables-restore <<R
*nat
:PREROUTING ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
-A PREROUTING -i eth0 -p tcp --dport 9000 -j DNAT --to-destination $GUEST
-A POSTROUTING -o tap0 -j MASQUERADE
COMMIT
*filter
:INPUT DROP [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A FORWARD -i eth0 -o tap0 -d $GUEST -p tcp --dport 9000 -j ACCEPT
COMMIT
R

"$FC/jailer" --id "$ID" --exec-file "$FC/firecracker" --uid "$VMUID" --gid "$VMUID" \
  --chroot-base-dir "$DIR/jail" --netns /var/run/netns/$NS --cgroup-version 2 --parent-cgroup "$CGROUP" \
  --cgroup "cpu.max=100000 100000" --cgroup "memory.max=2415919104" --cgroup pids.max=64 \
  --new-pid-ns --daemonize -- --api-sock /run/firecracker.socket
ln "$DIR/vmlinux" "$ROOT/vmlinux"
ln "$DIR/rootfs.ext4" "$ROOT/rootfs.ext4"
SOCK=$ROOT/run/firecracker.socket
for _ in $(seq 1 500); do [ -S "$SOCK" ] && break; sleep 0.01; done
api() { curl -sSf --unix-socket "$SOCK" -X "$1" "http://localhost$2" -H 'content-type: application/json' ${3:+-d "$3"}; }
api PUT /boot-source "{\"kernel_image_path\":\"/vmlinux\",\"boot_args\":\"$BOOT\"}"
api PUT /drives/rootfs '{"drive_id":"rootfs","path_on_host":"/rootfs.ext4","is_root_device":true,"is_read_only":true}'
api PUT /machine-config '{"vcpu_count":1,"mem_size_mib":2048,"smt":false}'
api PUT /network-interfaces/eth0 '{"iface_id":"eth0","guest_mac":"06:00:ac:10:00:02","host_dev_name":"tap0"}'
api PUT /entropy '{}'
t0=$(date +%s%N)
api PUT /actions '{"action_type":"InstanceStart"}'
for _ in $(seq 1 300); do
  curl -s -m 3 -H "authorization: Bearer $TOKEN" "http://10.200.255.2:9000/health?wait=2000" | grep -q '"status":"ready"' && break
  sleep 0.1
done
curl -s -m 3 -H "authorization: Bearer $TOKEN" "http://10.200.255.2:9000/health" | grep -q '"status":"ready"' \
  || { echo "the template's browser never became ready" >&2; exit 1; }
echo "template: browser ready $(( ($(date +%s%N)-t0)/1000000 )) ms after boot"
sleep 2 # let the first page settle before freezing it
api PATCH /vm '{"state":"Paused"}'
api PUT /snapshot/create '{"snapshot_type":"Full","snapshot_path":"/vmstate","mem_file_path":"/mem"}'
mv "$ROOT/vmstate" "$ROOT/mem" "$NEW/"
ln "$DIR/rootfs.ext4" "$NEW/rootfs.ext4"
printf '%s\n' "$TOKEN" > "$NEW/token"
chown root:"$VMUID" "$NEW/vmstate" "$NEW/mem" "$NEW/rootfs.ext4"
chmod 0640 "$NEW/vmstate" "$NEW/mem"; chmod 0644 "$NEW/rootfs.ext4"; chmod 0600 "$NEW/token"
rm -rf "$DIR/template.old"
[ -d "$DIR/template" ] && mv "$DIR/template" "$DIR/template.old"
mv "$NEW" "$DIR/template"
rm -rf "$DIR/template.old"
echo "template: $DIR/template"
