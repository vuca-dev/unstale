"""Slice 6 cost per arm (PREREG.md "Cost"), from each arm's usage log: gateway $ as the provider reported it, Jev $ as
input tokens x $0.042/M. Step E is not run by either arm (unchanged by the design).

    python3 -I slice6/cost6.py   (from eval/select)"""
import collections, json, os

H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(H, "out", "slice6")
JEV = 0.042e-6


def arm_cost(split, arm):
    f = os.path.join(OUT, split, arm, "central", "usage.jsonl")
    g = j = 0.0
    calls = collections.Counter()
    if os.path.exists(f):
        for l in open(f):
            u = json.loads(l)
            if u.get("api") == "vercel":
                g += u.get("dollars") or 0
                calls["gateway"] += 1
            elif u.get("api") == "jev":
                j += (u.get("input_tokens") or 0) * JEV
                calls["jev"] += 1
    return {"gateway": round(g, 5), "jev": round(j, 5), "total": round(g + j, 5), "calls": dict(calls)}


res = {}
for split in ("dev", "heldout", "gold"):
    for arm in ("rep", "shared", "shared-r0", "shared-r2", "shared-all"):
        if os.path.isdir(os.path.join(OUT, split, arm)):
            res[f"{split}/{arm}"] = arm_cost(split, arm)
for k, v in res.items():
    print(k, v)
if "heldout/rep" in res and "heldout/shared" in res:
    r, s = res["heldout/rep"], res["heldout/shared"]
    print(f"held-out saving (A+B+selection+D): ${r['total'] - s['total']:.4f} of ${r['total']:.4f} ({100 * (1 - s['total'] / r['total']):.1f}%)")
json.dump(res, open(os.path.join(OUT, "cost.json"), "w"), indent=1)
