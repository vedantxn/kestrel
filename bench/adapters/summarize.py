#!/usr/bin/env python3
"""Summarize a run-public.sh output directory as Markdown tables (stdlib only).
   summarize.py <out dir> <providers...>"""
import glob, json, os, sys

out = sys.argv[1]
providers = set(sys.argv[2:])

def pct(v, q):
    v = sorted(v)
    if not v:
        return None
    k = (len(v) - 1) * q
    f, c = int(k), min(int(k) + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)

def fmt(x):
    return "–" if x is None else f"{x:,.0f}"

print("## Browser Arena (hello-browser: create, connect, goto domcontentloaded, release)\n")
print("| Provider | Concurrency | Success | Create p50 / p95 | Connect p50 / p95 | Goto p50 / p95 | Release p50 / p95 | Total p50 / p95 |")
print("|---|---|---|---|---|---|---|---|")
# The arena's results folder also holds the upstream repo's own history: take only the named
# providers, and only their latest date (this run).
files = glob.glob(f"{out}/arena-results/hello-browser/*/*/c*/results.jsonl")
latest = {}
for f in files:
    parts = f.split(os.sep)
    if parts[-4] in providers:
        latest[parts[-4]] = max(latest.get(parts[-4], ""), parts[-3])
for f in sorted(files):
    parts = f.split(os.sep)
    prov, date, conc = parts[-4], parts[-3], parts[-2]
    if latest.get(prov) != date:
        continue
    rows = [json.loads(l) for l in open(f) if l.strip()]
    # Warm-up runs are written to the same file first; the measured runs are the last ARENA_RUNS.
    rows = rows[-int(os.environ.get("ARENA_RUNS", 100)):]
    ok = [r for r in rows if r.get("success")]
    cell = lambda k: f"{fmt(pct([r[k] for r in ok if isinstance(r.get(k), (int, float))], .5))} / {fmt(pct([r[k] for r in ok if isinstance(r.get(k), (int, float))], .95))}"
    tot = [sum(r.get(k) or 0 for k in ("session_creation_ms", "session_connect_ms", "page_goto_ms", "session_release_ms")) for r in ok]
    print(f"| {prov} | {conc[1:]} | {len(ok)}/{len(rows)} | {cell('session_creation_ms')} | {cell('session_connect_ms')} | {cell('page_goto_ms')} | {cell('session_release_ms')} | {fmt(pct(tot, .5))} / {fmt(pct(tot, .95))} |")

print("\n## ComputeSDK browser lifecycle (create, connect, goto example.com load, release)\n")
print("| Provider | Success | Create p50 / p95 | Connect p50 / p95 | Navigate p50 / p95 | Release p50 / p95 | Total p50 / p95 / p99 |")
print("|---|---|---|---|---|---|---|")
for f in sorted(glob.glob(f"{out}/csdk-lifecycle-*.json")):
    for r in json.load(open(f))["results"]:
        it = r["iterations"]
        ok = [i for i in it if not i.get("error")]
        s = r["summary"]
        c = lambda k: f"{fmt(s[k]['median'])} / {fmt(s[k]['p95'])}"
        print(f"| {r['provider']} | {len(ok)}/{len(it)} | {c('createMs')} | {c('connectMs')} | {c('navigateMs')} | {c('releaseMs')} | {fmt(s['totalMs']['median'])} / {fmt(s['totalMs']['p95'])} / {fmt(s['totalMs']['p99'])} |")

print("\n## ComputeSDK browser throughput (10 actions on Wikipedia per session)\n")
print("| Provider | Sessions ok | Actions/s p50 | Task p50 ms | Create p50 | Connect p50 | Release p50 |")
print("|---|---|---|---|---|---|---|")
for f in sorted(glob.glob(f"{out}/csdk-throughput-*.json")):
    d = json.load(open(f))
    for r in d.get("results", []):
        it = r.get("iterations") or r.get("sessions") or []
        ok = [i for i in it if not i.get("error")]
        g = lambda k: fmt(pct([i[k] for i in ok if isinstance(i.get(k), (int, float))], .5))
        aps = pct([i["actionsPerSecond"] for i in ok if isinstance(i.get("actionsPerSecond"), (int, float))], .5)
        print(f"| {r['provider']} | {len(ok)}/{len(it)} | {'–' if aps is None else f'{aps:.2f}'} | {g('taskMs')} | {g('createMs')} | {g('connectMs')} | {g('releaseMs')} |")
