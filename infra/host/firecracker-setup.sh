#!/usr/bin/env bash
# Install Firecracker and the guest kernel for the microVM runtime (experiment V7, HLD 16 item 5).
# Pinned by version and checksum. Run as root on the host:  sudo infra/host/firecracker-setup.sh
# Installs to /opt/firecracker: firecracker, jailer, vmlinux. Idempotent.
set -euo pipefail
FC_VERSION=v1.17.0
FC_SHA256=06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558
# Firecracker's CI guest kernel (6.1, with ACPI, VMGenID, user namespaces, seccomp, IP autoconfig).
KERNEL_URL=https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/x86_64/vmlinux-6.1.155
KERNEL_SHA256=${KERNEL_SHA256:-e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2}
DEST=/opt/firecracker

[ -c /dev/kvm ] || { echo "no /dev/kvm: enable nested virtualisation on the instance (var.nested_virtualization)" >&2; exit 1; }
mkdir -p "$DEST"
if [ "$("$DEST/firecracker" --version 2>/dev/null | head -1)" != "Firecracker $FC_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/fc.tgz" "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-x86_64.tgz"
  echo "$FC_SHA256  $tmp/fc.tgz" | sha256sum -c - >/dev/null
  tar -xzf "$tmp/fc.tgz" -C "$tmp"
  install -m 0755 "$tmp/release-$FC_VERSION-x86_64/firecracker-$FC_VERSION-x86_64" "$DEST/firecracker"
  install -m 0755 "$tmp/release-$FC_VERSION-x86_64/jailer-$FC_VERSION-x86_64" "$DEST/jailer"
  rm -rf "$tmp"
fi
if [ ! -f "$DEST/vmlinux" ]; then
  curl -fsSL -o "$DEST/vmlinux.tmp" "$KERNEL_URL"
  if [ -n "$KERNEL_SHA256" ]; then echo "$KERNEL_SHA256  $DEST/vmlinux.tmp" | sha256sum -c - >/dev/null; fi
  mv "$DEST/vmlinux.tmp" "$DEST/vmlinux"
fi
# Firecracker's userfaultfd page-fault handler (its example, built from the same pinned release):
# serves a clone's memory as 2 MiB pages from the snapshot (ADR 0017). Built once, in a container.
if [ ! -x "$DEST/uffd_on_demand_handler" ]; then
  src=$(mktemp -d /data/fc-src.XXXX)
  git clone -q --depth 1 --branch "$FC_VERSION" https://github.com/firecracker-microvm/firecracker "$src"
  docker run --rm -v "$src:/src" -w /src/src/firecracker -e CARGO_HOME=/src/.cargo rust:1.97 bash -c \
    "apt-get update -qq >/dev/null && apt-get install -y -qq libclang-dev clang libseccomp-dev >/dev/null 2>&1 && cargo build -q --release --example uffd_on_demand_handler"
  install -m 0755 "$src/build/cargo_target/release/examples/uffd_on_demand_handler" "$DEST/uffd_on_demand_handler"
  rm -rf "$src"
fi
"$DEST/firecracker" --version | head -1
sha256sum "$DEST/vmlinux"

# What the microVM runtime needs from the host at every boot (deploy installs this as a unit):
# a cgroup v2 parent with the CPU, memory and process controllers for the jailer, and /run/netns as
# a shared mount, so the network namespaces the node agent makes from its container live on the host.
CGROUP=${MICROVM_CGROUP:-kestrel-vm}
mkdir -p "/sys/fs/cgroup/$CGROUP"
echo "+cpu +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control
echo "+cpu +memory +pids" > "/sys/fs/cgroup/$CGROUP/cgroup.subtree_control"
ip netns add kestrel-init 2>/dev/null && ip netns del kestrel-init
# The 2 MiB page pool for clones' memory (a clone uses about 800 MB of it); default half the host.
pages=${MICROVM_HUGEPAGES:-$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 2 / 2 ))}
echo "$pages" > /proc/sys/vm/nr_hugepages
mkdir -p /data/kestrel-vm/jail /data/kestrel-vm/meta && chmod 0700 /data/kestrel-vm/meta
