"""Percentiles of the public benchmarks' raw results, the numbers the results READMEs quote.

    python3 bench/adapters/tail.py <result dir> [<result dir> ...]

Pools every run in the given folders (rounds of the same setup), and prints the total of each
lifecycle (create + connect + navigate + release, ms) at p50 / p95 / p99 / max: Browser Arena one at
a time (c1) and ten at once (c10), and ComputeSDK's lifecycle. Percentiles interpolate linearly
between samples. ComputeSDK's own summary (summarize.py) rounds differently, so its p95 and p99
can differ slightly from these; the READMEs use these.
"""
import glob
import json
import sys


def pct(v, q):
    v = sorted(v)
    k = (len(v) - 1) * q
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def line(name, totals):
    if not totals:
        return
    print(f"{name:<11} n={len(totals):<4} p50 {pct(totals, .5):.0f} p95 {pct(totals, .95):.0f} "
          f"p99 {pct(totals, .99):.0f} max {max(totals):.0f}")


dirs = sys.argv[1:]
if not dirs:
    sys.exit(__doc__)
ks = ["session_creation_ms", "session_connect_ms", "page_goto_ms", "session_release_ms"]
arena = {"c1": [], "c10": []}
csdk = []
for d in dirs:
    for level in arena:
        for f in glob.glob(f"{d}/arena-results/hello-browser/*/*/{level}/results.jsonl"):
            rows = [json.loads(x) for x in open(f)]
            # The last 100 are the measured runs; any before them were the warm-up.
            arena[level] += [r for r in rows[-100:] if all(k in r for k in ks)]
    for f in glob.glob(f"{d}/csdk-lifecycle-*.json"):
        csdk += [x for r in json.load(open(f))["results"] for x in r["iterations"] if not x.get("error")]

line("arena c1", [sum(r[k] for k in ks) for r in arena["c1"]])
line("arena c10", [sum(r[k] for k in ks) for r in arena["c10"]])
line("csdk", [x["totalMs"] for x in csdk])
if arena["c1"]:
    print("slowest arena c1 (total, create, navigate):",
          [(round(sum(r[k] for k in ks)), round(r["session_creation_ms"]), round(r["page_goto_ms"]))
           for r in sorted(arena["c1"], key=lambda r: -sum(r[k] for k in ks))[:5]])
if csdk:
    print("slowest csdk (total, create, navigate):",
          [(round(x["totalMs"]), round(x["createMs"]), round(x["navigateMs"]))
           for x in sorted(csdk, key=lambda x: -x["totalMs"])[:5]])
