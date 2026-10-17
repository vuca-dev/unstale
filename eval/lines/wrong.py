"""Versions wrongly shown as already having a record's change (eval/lines/RESULTS.md).

usage: python3 wrong.py <central dir> <catalog dir> [technology=next] [npm package=next]

Truth (research rule, registry dates): v has the change iff a release the change shipped in (the record's sources and
releases) is on v's minor line at or below v, or v's minor line's first release (registry) was published after the
earliest of them. Shown: the edge contract (contract.py) on the published catalog; versions it cannot place use the
old rule. Pairs: active records x stable registry versions published since 2025-06-01.
"""
import json, os, re, sys, urllib.request, gzip

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from contract import Index, has_change, old_rule, key

central, catalog = sys.argv[1], sys.argv[2]
tech = sys.argv[3] if len(sys.argv) > 3 else "next"
pkg = sys.argv[4] if len(sys.argv) > 4 else "next"
cache = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"npm-time-{pkg.replace('/', '_')}.json")
if os.path.exists(cache):
    vt = json.load(open(cache))
else:
    vt = json.load(urllib.request.urlopen(f"https://registry.npmjs.org/{pkg.replace('/', '%2F')}"))["time"]
    json.dump(vt, open(cache, "w"))
vt = {v: t for v, t in vt.items() if re.fullmatch(r"\d+\.\d+\.\d+", v)}
first = {}
for v in vt:
    m = key(v)[:2]
    if m not in first or vt[v] < vt[first[m]]:
        first[m] = v
R = json.load(open(os.path.join(central, "records", f"{tech}.json")))["records"]
ti = json.load(open(os.path.join(catalog, "v1", "tech", f"{tech}.json")))
idx = Index(ti.get("releases", []))
comp = f"pkg:npm/{pkg.replace('@', '%40')}"
out = {"wrong_in_index": 0, "wrong_outside": 0, "missed_in_index": 0, "missed_outside": 0, "pairs": 0}
recs, examples = set(), []
for k, r in R.items():
    if r["status"] != "active":
        continue
    fx = {m[1] for s in r["sources"] if (m := re.match(rf"{re.escape(tech)}@(\d+\.\d+\.\d+)[#+]", s))}
    rels = [x["version"] for x in r["releases"] if x["component"] == comp]
    fx = {f for f in fx | set(rels) if f in vt}
    if not fx or not rels:
        continue
    earliest = min(vt[f] for f in fx)
    for v in vt:
        if vt[v] < "2025-06-01":
            continue
        truth = any(key(f)[:2] == key(v)[:2] and key(f) <= key(v) for f in fx) or vt[first[key(v)[:2]]] > earliest
        shown = has_change(rels, v, idx)
        if shown is None:
            shown = old_rule(rels, v)
        where = "in_index" if v in idx.pos else "outside"
        out["pairs"] += 1
        if shown and not truth:
            out[f"wrong_{where}"] += 1
            recs.add(k)
            if len(examples) < 8:
                examples.append((k, v, rels))
        elif truth and not shown:
            out[f"missed_{where}"] += 1
out["records_wrong"] = len(recs)
print(json.dumps(out))
print(sorted(recs)[:15])
for e in examples:
    print(e)
