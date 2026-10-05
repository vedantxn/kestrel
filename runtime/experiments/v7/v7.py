#!/usr/bin/env python3
"""Experiment V7: restore Kestrel browsers from a snapshot of a running one (HLD 16 item 5).

Run as root on the host, from the repository root, after infra/host/firecracker-setup.sh and
runtime/microvm/build-rootfs.sh:

    sudo python3 runtime/experiments/v7/v7.py template      # boot one VM, wait for the browser, snapshot it
    sudo python3 runtime/experiments/v7/v7.py restore N C   # N clones, C at once: restore -> health -> configure
    sudo python3 runtime/experiments/v7/v7.py keep K        # leave K configured clones for uniq.mjs
    sudo python3 runtime/experiments/v7/v7.py clean

Each clone runs in its own network namespace: a tap for the VM (the guest is 172.16.0.2 in every
clone, as the snapshot says) and a veth to the host at 10.200.<i>.2, with NAT in the namespace. The
host reaches a clone's runtimed at 10.200.<i>.2:9000; the guest's proxy address 172.16.0.1:3128 is
sent to 10.200.<i>.1:3199 on the host. Standard library only (the host has Python 3.9, no Node).
"""
import http.client
import json
import os
import socket
import statistics
import subprocess
import sys
import threading
import time

FC = "/opt/firecracker/firecracker"
KERNEL = "/opt/firecracker/vmlinux"
WORK = "/data/kestrel-vm"
ROOTFS = f"{WORK}/rootfs.ext4"
SNAP = f"{WORK}/snap"
RUN = "/run/kestrel-vm"
TOKEN = "v7-template-token-0123456789abcdef"
# How a clone's memory is served: "file" (the snapshot file mapped copy-on-write, 4 KiB pages),
# "thp" (the same, asking for transparent huge pages), or "uffd" (2 MiB hugetlbfs pages filled
# on demand by Firecracker's example userfaultfd handler, V7_UFFD_HANDLER).
BACKEND = os.environ.get("V7_BACKEND", "file")
UFFD_HANDLER = os.environ.get("V7_UFFD_HANDLER", "/opt/firecracker/uffd_on_demand_handler")  # the template's; a clone is re-keyed by the agent
PROOF = "ab" * 32
GUEST = "172.16.0.2"
BOOT_ARGS = (
    "console=ttyS0 reboot=k panic=1 pci=off quiet ro init=/init "
    f"ip={GUEST}::172.16.0.1:255.255.255.0::eth0:off "
    f"KESTREL_CONTROL_TOKEN={TOKEN} KESTREL_PROXY=http://172.16.0.1:3128"
)


def sh(cmd: str, check: bool = True) -> str:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{cmd}: {r.stderr.strip()}")
    return r.stdout


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost", timeout=30)
        self.path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


def api(sock: str, method: str, path: str, body: object = None) -> None:
    c = UnixHTTP(sock)
    c.request(method, path, json.dumps(body) if body is not None else None,
              {"content-type": "application/json"})
    r = c.getresponse()
    data = r.read()
    c.close()
    if r.status >= 300:
        raise RuntimeError(f"firecracker {method} {path}: {r.status} {data[:300]!r}")


def runtimed(addr: str, method: str, path: str, body: object = None, timeout: float = 5,
             token: str = TOKEN) -> dict:
    c = http.client.HTTPConnection(addr, 9000, timeout=timeout)
    c.request(method, path, json.dumps(body) if body is not None else None,
              {"authorization": f"Bearer {token}", "content-type": "application/json"})
    r = c.getresponse()
    data = r.read()
    c.close()
    if r.status >= 300:
        raise RuntimeError(f"runtimed {path}: {r.status} {data[:200]!r}")
    return json.loads(data)


def netns(i: int) -> float:
    """A namespace for clone i; returns how long making it took (ms)."""
    t0 = time.perf_counter()
    n = f"kvm{i}"
    sh(f"""
ip netns add {n}
ip netns exec {n} ip link set lo up
ip netns exec {n} ip tuntap add tap0 mode tap
ip netns exec {n} ip addr add 172.16.0.1/24 dev tap0
ip netns exec {n} ip link set tap0 up
ip link add vh{i} type veth peer name vn{i}
ip link set vn{i} netns {n}
ip addr add 10.200.{i}.1/30 dev vh{i}
ip link set vh{i} up
ip netns exec {n} ip addr add 10.200.{i}.2/30 dev vn{i}
ip netns exec {n} ip link set vn{i} up
ip netns exec {n} sysctl -qw net.ipv4.ip_forward=1
ip netns exec {n} iptables-restore <<'R'
*nat
:PREROUTING ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
-A PREROUTING -i vn{i} -p tcp -m multiport --dports 9000,9223 -j DNAT --to-destination {GUEST}
-A PREROUTING -i tap0 -d 172.16.0.1 -p tcp --dport 3128 -j DNAT --to-destination 10.200.{i}.1:3199
-A POSTROUTING -o vn{i} -j MASQUERADE
-A POSTROUTING -o tap0 -j MASQUERADE
COMMIT
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A FORWARD -i vn{i} -o tap0 -d {GUEST} -p tcp -m multiport --dports 9000,9223 -j ACCEPT
-A FORWARD -i tap0 -o vn{i} -s {GUEST} -d 10.200.{i}.1 -p tcp --dport 3199 -j ACCEPT
COMMIT
R
""")
    return (time.perf_counter() - t0) * 1000


def drop_netns(i: int) -> None:
    sh(f"ip netns del kvm{i}", check=False)
    sh(f"ip link del vh{i}", check=False)


def template() -> None:
    os.makedirs(SNAP, exist_ok=True)
    os.makedirs(RUN, exist_ok=True)
    drop_netns(0)
    netns(0)
    sock = f"{RUN}/t.sock"
    if os.path.exists(sock):
        os.unlink(sock)
    cfg = {
        "boot-source": {"kernel_image_path": KERNEL, "boot_args": BOOT_ARGS},
        "drives": [{"drive_id": "rootfs", "path_on_host": ROOTFS, "is_root_device": True,
                    "is_read_only": True}],
        "machine-config": {"vcpu_count": 1, "mem_size_mib": 2048, "smt": False},
        "network-interfaces": [{"iface_id": "eth0", "guest_mac": "06:00:ac:10:00:02",
                                "host_dev_name": "tap0"}],
        "entropy": {},
    }
    with open(f"{RUN}/t.json", "w") as f:
        json.dump(cfg, f)
    log = open(f"{WORK}/template.log", "w")
    t0 = time.perf_counter()
    p = subprocess.Popen(["ip", "netns", "exec", "kvm0", FC, "--api-sock", sock,
                          "--config-file", f"{RUN}/t.json"], stdout=log, stderr=log)
    addr = "10.200.0.2"
    for _ in range(600):
        try:
            h = runtimed(addr, "GET", "/health?wait=2000", timeout=4)
            if h.get("status") == "ready":
                break
        except Exception:
            time.sleep(0.1)
    else:
        p.kill()
        raise SystemExit("the template's browser never became ready; see template.log")
    boot = (time.perf_counter() - t0) * 1000
    time.sleep(2)  # let the first page settle before freezing it
    api(sock, "PATCH", "/vm", {"state": "Paused"})
    t1 = time.perf_counter()
    api(sock, "PUT", "/snapshot/create", {"snapshot_type": "Full",
                                          "snapshot_path": f"{SNAP}/vmstate",
                                          "mem_file_path": f"{SNAP}/mem"})
    snap = (time.perf_counter() - t1) * 1000
    p.kill()
    p.wait()
    drop_netns(0)
    print(json.dumps({"bootToReadyMs": round(boot), "snapshotMs": round(snap),
                      "memFileMiB": os.path.getsize(f"{SNAP}/mem") // (1 << 20)}))


procs: dict = {}


def restore(i: int, configure: bool = True) -> dict:
    """Restore clone i from the snapshot; the namespace must exist. Phase times in ms."""
    sock = f"{RUN}/{i}.sock"
    if os.path.exists(sock):
        os.unlink(sock)
    t0 = time.perf_counter()
    p = subprocess.Popen(["ip", "netns", "exec", f"kvm{i}", FC, "--api-sock", sock,
                          "--level", "Warn"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs[i] = p
    while not os.path.exists(sock):
        time.sleep(0.001)
    t1 = time.perf_counter()
    load = {"snapshot_path": f"{SNAP}/vmstate", "resume_vm": True,
            "mem_backend": {"backend_type": "File", "backend_path": f"{SNAP}/mem"}}
    if BACKEND == "thp":
        load["huge_pages"] = "Transparent"
    elif BACKEND == "uffd":
        uds = f"{RUN}/{i}.uffd"
        if os.path.exists(uds):
            os.unlink(uds)
        hlog = open(f"{RUN}/{i}.uffd.log", "w")
        procs[f"h{i}"] = subprocess.Popen([UFFD_HANDLER, uds, f"{SNAP}/mem"],
                                          stdout=hlog, stderr=hlog)
        while not os.path.exists(uds):
            time.sleep(0.001)
        load["mem_backend"] = {"backend_type": "Uffd", "backend_path": uds}
        load["huge_pages"] = "2M"
    api(sock, "PUT", "/snapshot/load", load)
    t2 = time.perf_counter()
    addr = f"10.200.{i}.2"
    for _ in range(3000):
        try:
            h = runtimed(addr, "GET", "/health", timeout=1)
            if h.get("status") == "ready":
                break
        except Exception:
            time.sleep(0.002)
    t3 = time.perf_counter()
    out = {"spawn": (t1 - t0) * 1000, "load": (t2 - t1) * 1000, "health": (t3 - t2) * 1000}
    if configure:
        r = runtimed(addr, "POST", "/configure", {"sessionProof": PROOF,
                                                  "viewport": {"width": 1280, "height": 720}},
                     timeout=10)
        assert r["viewport"] == {"width": 1280, "height": 720}, r
        out["configure"] = (time.perf_counter() - t3) * 1000
    out["total"] = (time.perf_counter() - t0) * 1000
    return out


def kill(i: int) -> float:
    t0 = time.perf_counter()
    for k in (i, f"h{i}"):
        p = procs.pop(k, None)
        if p:
            p.kill()
            p.wait()
    return (time.perf_counter() - t0) * 1000


def pct(v: list, q: float) -> float:
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(round(q * len(v) + 0.5)) - 1))]


def summary(v: list) -> dict:
    return {"n": len(v), "p50": round(pct(v, .5)), "p95": round(pct(v, .95)),
            "p99": round(pct(v, .99)), "max": round(max(v))}


def cmd_restore(n: int, conc: int) -> None:
    os.makedirs(RUN, exist_ok=True)
    ns_ms = []
    for i in range(1, conc + 1):
        drop_netns(i)
        ns_ms.append(netns(i))
    results: list = []
    kills: list = []
    lock = threading.Lock()
    todo = list(range(n))
    t0 = time.perf_counter()

    def worker(slot: int) -> None:
        while True:
            with lock:
                if not todo:
                    return
                todo.pop()
            r = restore(slot)
            k = kill(slot)
            with lock:
                results.append(r)
                kills.append(k)

    ts = [threading.Thread(target=worker, args=(s,)) for s in range(1, conc + 1)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    wall = time.perf_counter() - t0
    for i in range(1, conc + 1):
        drop_netns(i)
    print(json.dumps({
        "clones": n, "atOnce": conc, "perSecond": round(n / wall, 2),
        "netnsSetupMs": summary(ns_ms),
        **{k: summary([r[k] for r in results]) for k in ["spawn", "load", "health", "configure", "total"]},
        "killMs": summary(kills),
    }))


def cmd_keep(k: int) -> None:
    os.makedirs(RUN, exist_ok=True)
    for i in range(1, k + 1):
        drop_netns(i)
        netns(i)
        r = restore(i)
        print(json.dumps({"clone": i, "address": f"10.200.{i}.2", **{x: round(y) for x, y in r.items()}}))
        # detach: the clone (and its page-fault handler) outlives this process
        procs.pop(i)
        procs.pop(f"h{i}", None)


def cmd_clean() -> None:
    sh("pkill -f 'firecracker --api-sock' || true", check=False)
    sh("pkill -f uffd_on_demand_handler || true", check=False)
    for i in range(0, 64):
        drop_netns(i)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "template":
        template()
    elif cmd == "restore":
        cmd_restore(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == "keep":
        cmd_keep(int(sys.argv[2]))
    elif cmd == "boot":
        # A VM booted normally and left running at 10.200.0.2 (no snapshot), for comparison.
        os.makedirs(RUN, exist_ok=True)
        drop_netns(0)
        netns(0)
        cfg = {"boot-source": {"kernel_image_path": KERNEL, "boot_args": BOOT_ARGS},
               "drives": [{"drive_id": "rootfs", "path_on_host": ROOTFS, "is_root_device": True, "is_read_only": True}],
               "machine-config": {"vcpu_count": 1, "mem_size_mib": 2048, "smt": False},
               "network-interfaces": [{"iface_id": "eth0", "guest_mac": "06:00:ac:10:00:02", "host_dev_name": "tap0"}],
               "entropy": {}}
        with open(f"{RUN}/b.json", "w") as f:
            json.dump(cfg, f)
        subprocess.Popen(["ip", "netns", "exec", "kvm0", FC, "--api-sock", f"{RUN}/b.sock", "--config-file", f"{RUN}/b.json"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(600):
            try:
                if runtimed("10.200.0.2", "GET", "/health?wait=2000", timeout=4).get("status") == "ready":
                    break
            except Exception:
                time.sleep(0.1)
        print("booted")
    elif cmd == "clean":
        cmd_clean()
    else:
        print(__doc__)
        sys.exit(2)
