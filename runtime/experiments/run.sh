#!/usr/bin/env bash
# Experiments V1-V5 (v1 plan section 5). Run on the Linux host, from the repository root:
#   runtime/experiments/run.sh
# Starts containers with the agent's exact hardening flags (apps/node/src/docker.ts) and measures.
set -uo pipefail
IMAGE=${IMAGE:-kestrel-runtime:dev}
NET=ksl-x
TOKEN=experiment-token-0123456789
SECCOMP=$PWD/runtime/seccomp/seccomp-chrome.json
PROOF=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')

docker network inspect $NET >/dev/null 2>&1 || docker network create --internal --driver bridge \
  --opt com.docker.network.bridge.name=ksl-x --opt com.docker.network.bridge.enable_icc=false \
  --subnet 172.31.9.0/24 --gateway 172.31.9.1 $NET >/dev/null

# start NAME SECCOMP_MODE(default|chrome|unconfined) [extra docker flags...]  -> prints container id
start() {
  local name=$1 sec=$2; shift 2
  local secopt=()
  case $sec in chrome) secopt=(--security-opt "seccomp=$SECCOMP");; unconfined) secopt=(--security-opt seccomp=unconfined);; esac
  docker run -d --name "$name" --network $NET --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges \
    "${secopt[@]}" --read-only --pids-limit 1024 --memory 2048m --memory-swap 2048m --cpus 1 --shm-size 1024m \
    --tmpfs /profile:rw,noexec,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0700 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700 \
    --tmpfs /home/kestrel:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700 \
    --init --restart no --dns 127.0.0.1 -e KESTREL_CONTROL_TOKEN=$TOKEN -e KESTREL_PROXY=http://172.31.9.1:3128 "$@" $IMAGE
}
ip_of() { docker inspect -f '{{(index .NetworkSettings.Networks "'$NET'").IPAddress}}' "$1"; }
health() { curl -s -m 2 -H "authorization: Bearer $TOKEN" "http://$1:9000/health"; }
# wait_ready NAME SECONDS -> echoes milliseconds to ready, or FAIL
wait_ready() {
  local name=$1 max=$2 t0 ip; t0=$(date +%s%N)
  for _ in $(seq 1 $((max*10))); do
    [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || { echo FAIL; return; }
    ip=$(ip_of "$name"); [ -n "$ip" ] && health "$ip" | grep -q '"status":"ready"' && { echo $(( ($(date +%s%N)-t0)/1000000 )); return; }
    sleep 0.1
  done; echo FAIL
}
cleanup() { docker rm -f "$@" >/dev/null 2>&1; }

echo "== V1: does Chrome's sandbox run under the full hardening?"
cleanup v1a v1b
start v1a default >/dev/null; a=$(wait_ready v1a 30)
echo "  Docker's default seccomp profile, sandbox ON: $a  $( [ "$a" = FAIL ] && docker logs v1a 2>&1 | grep -iE 'sandbox|namespace|fatal' | head -2 | tr '\n' ' ')"
start v1b chrome >/dev/null; b=$(wait_ready v1b 30)
echo "  seccomp-chrome.json, sandbox ON: $b ms"
[ "$b" = FAIL ] && docker logs v1b 2>&1 | tail -5

echo "== V2: no-exec shared memory and tmpfs (all runs above are no-exec: ready means it works)"
echo "  /dev/shm: $(docker exec v1b sh -c 'grep " /dev/shm " /proc/mounts' 2>/dev/null)"
echo "  /profile: $(docker exec v1b sh -c 'grep " /profile " /proc/mounts' 2>/dev/null)"

echo "== V3: viewport sizing and a pop-up window, without a window manager"
if [ "$b" != FAIL ]; then
  ip=$(ip_of v1b)
  r=$(curl -s -m 20 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"sessionProof\":\"$PROOF\",\"viewport\":{\"width\":1280,\"height\":720}}" "http://$ip:9000/configure")
  echo "  configure 1280x720 -> $r"
  r2=$(curl -s -m 20 -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d "{\"sessionProof\":\"$PROOF\",\"viewport\":{\"width\":800,\"height\":600}}" "http://$ip:9000/configure")
  echo "  configure again 800x600 (same session) -> $r2"
fi

echo "== V4: time from docker run to ready (20 runs, median)"
ms=()
for _ in $(seq 1 20); do cleanup v4; start v4 chrome >/dev/null; ms+=("$(wait_ready v4 30)"); cleanup v4; done
printf '  %s\n' "${ms[*]}"
printf '%s\n' "${ms[@]}" | grep -v FAIL | sort -n | awk '{a[NR]=$1} END{ if (NR) { p=int(NR*0.95); if (p<1) p=1; printf "  median %s ms, p95 %s ms, n=%d\n", a[int((NR+1)/2)], a[p], NR } }'

echo "== V5: memory of an idle session"
cleanup v5; start v5 chrome >/dev/null; wait_ready v5 30 >/dev/null; sleep 5
echo "  docker stats: $(docker stats --no-stream --format '{{.MemUsage}}' v5)"
echo "  runtimed RSS: $(docker exec v5 sh -c 'for p in /proc/[0-9]*; do n=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$n" in *runtimed*) awk "/VmRSS/{print \$2/1024 \" MB\"}" $p/status;; esac; done' 2>&1 | head -1)"
cleanup v1a v1b v5
docker network rm $NET >/dev/null 2>&1
echo "== done"
