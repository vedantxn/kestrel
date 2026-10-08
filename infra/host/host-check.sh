#!/usr/bin/env bash
# C15: the host prerequisites Kestrel relies on. Exits non-zero and says which one failed.
# Installed at /usr/local/bin/kestrel-host-check by infra/host/prepare-host.sh; run by `bin/host check`
# and at the start of every deploy. KESTREL_QUOTA=off (from /etc/kestrel/host.env, set by
# prepare-host.sh --no-quota) turns the xfs checks into warnings: recording is then off.
set -u
# shellcheck disable=SC1091
[ -f /etc/kestrel/host.env ] && . /etc/kestrel/host.env
KESTREL_QUOTA=${KESTREL_QUOTA:-on}

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
info() { printf '  info  %s\n' "$1"; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

echo "kestrel host check"

# x86_64 only: the runtime image and Chrome for Testing are amd64 builds.
[ "$(uname -m)" = x86_64 ] && ok "x86_64" || bad "$(uname -m): Kestrel needs an x86_64 host"
# cgroup v2: the node agent's limits and the microVM jailer use it.
[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" = cgroup2fs ] && ok "cgroup v2" || bad "cgroup v2 is not mounted at /sys/fs/cgroup"

# Docker 25.0.5 or later: earlier 25.0 releases broke host access to internal networks (I9).
dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
if [ -z "$dv" ]; then bad "docker is not running"
elif version_ge "$dv" "25.0.5"; then ok "docker $dv (>= 25.0.5)"
else bad "docker $dv is older than 25.0.5"; fi

# Daemon settings (I12): containers survive a daemon restart; logs never block a container.
if [ -n "$dv" ]; then
  [ "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" = "true" ] && ok "live-restore on" || bad "live-restore is off"
  [ "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)" = "journald" ] && ok "log driver journald" || bad "log driver is not journald"
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  case "$root" in /data/docker) ok "docker data on the data volume ($root)";; *) bad "docker data-root is $root, not /data/docker";; esac
  grep -q '"non-blocking"' /etc/docker/daemon.json 2>/dev/null && ok "non-blocking log mode" || bad "log mode is not non-blocking"
fi

# The data volume, formatted xfs with project quotas (I10).
quota_bad() { if [ "$KESTREL_QUOTA" = off ]; then info "$1 (KESTREL_QUOTA=off: recording is off)"; else bad "$1"; fi; }
if findmnt -no FSTYPE,OPTIONS /data 2>/dev/null | grep -q '^xfs'; then
  findmnt -no OPTIONS /data | grep -Eq '(prjquota|pquota)' && ok "/data is xfs with project quotas" || quota_bad "/data is xfs without project quotas"
else
  quota_bad "/data is not an xfs mount"
fi

# Recording volumes (W3): Docker's volumes directory is noexec and nosuid.
if findmnt -no OPTIONS /data/docker/volumes 2>/dev/null | grep -q noexec; then
  findmnt -no OPTIONS /data/docker/volumes | grep -q nosuid && ok "/data/docker/volumes is noexec,nosuid" || bad "/data/docker/volumes is not nosuid"
else
  bad "/data/docker/volumes is not a noexec mount (recordings would be executable)"
fi

# Instance metadata: tokens required, hop limit 1 (I11). A container must not obtain instance credentials.
tok=$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
if [ -n "$tok" ]; then
  if curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/instance-id | grep -q '^401$'; then
    ok "metadata requires a token"
  else
    bad "metadata answered without a token"
  fi
else
  info "metadata service unreachable from here (skipped)"
fi

# Kernel settings Chrome's sandbox and many containers need.
un=$(sysctl -n user.max_user_namespaces 2>/dev/null || echo 0)
[ "${un:-0}" -gt 0 ] && ok "user namespaces allowed (user.max_user_namespaces=$un)" || bad "user namespaces are disabled"
ii=$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || echo 0)
[ "${ii:-0}" -ge 512 ] && ok "inotify instances $ii" || bad "fs.inotify.max_user_instances=$ii (< 512)"

# Ubuntu 24.04 can forbid unprivileged user namespaces through AppArmor, which Chrome's sandbox uses.
aa=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
[ "${aa:-0}" = 0 ] && ok "AppArmor does not restrict user namespaces" || info "kernel.apparmor_restrict_unprivileged_userns=$aa"
# The microVM runtime (ADR 0017) needs KVM; Docker nodes do not.
[ -c /dev/kvm ] && info "/dev/kvm present: the microVM runtime is available" || info "no /dev/kvm: Docker runtime only"

# The firewall tooling the node agent will drive, and which backend it uses (experiment V6).
if command -v iptables >/dev/null; then
  info "iptables: $(iptables --version 2>/dev/null)"
else
  bad "iptables is not installed"
fi

# Directories.
for d in /var/lib/kestrel /srv/kestrel; do [ -d "$d" ] && ok "$d exists" || bad "$d is missing"; done

[ "$fail" = 0 ] && echo "host check passed" || echo "host check FAILED"
exit "$fail"
