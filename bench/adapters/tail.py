import json,glob,sys
def pct(v,q):
    v=sorted(v); k=(len(v)-1)*q; f=int(k); c=min(f+1,len(v)-1); return v[f]+(v[c]-v[f])*(k-f)
dirs=sys.argv[1:]
ks=["session_creation_ms","session_connect_ms","page_goto_ms","session_release_ms"]
arena=[]; csdk=[]
for d in dirs:
    for f in glob.glob(f"{d}/arena-results/hello-browser/*/*/c1/results.jsonl"):
        arena+= [json.loads(l) for l in open(f)][-100:]
    for f in glob.glob(f"{d}/csdk-lifecycle-*.json"):
        csdk+= [x for r in json.load(open(f))["results"] for x in r["iterations"] if not x.get("error")]
at=[sum(r[k] for k in ks) for r in arena]; ct=[x["totalMs"] for x in csdk]
print(f"arena n={len(at)} p50 {pct(at,.5):.0f} p95 {pct(at,.95):.0f} p99 {pct(at,.99):.0f} max {max(at):.0f}")
print(f"csdk  n={len(ct)} p50 {pct(ct,.5):.0f} p95 {pct(ct,.95):.0f} p99 {pct(ct,.99):.0f} max {max(ct):.0f}")
print("slowest arena:", [(sum(r[k] for k in ks), r["session_creation_ms"], r["page_goto_ms"]) for r in sorted(arena,key=lambda r:-sum(r[k] for k in ks))[:5]])
print("slowest csdk :", [(round(x["totalMs"]), round(x["createMs"]), round(x["navigateMs"])) for x in sorted(csdk,key=lambda x:-x["totalMs"])[:5]])
