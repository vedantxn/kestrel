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
"$DEST/firecracker" --version | head -1
sha256sum "$DEST/vmlinux"
