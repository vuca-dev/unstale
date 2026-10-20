"""Slice 7 cost per split (PREREG.md "Cost reporting"): `rep` (per-package extraction, as production) against the
design = the shared extraction and labels (slice 6's `shared-all` logs) + the relevance calls (this slice's logs),
for the split's units. Gateway $ as the provider reported it; Jev $ = input tokens x $0.042/M. Step E not run.
    python3 -I slice7/cost7.py   (from eval/select)"""
import json, os
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
S6, S7 = os.path.join(H, "out", "slice6"), os.path.join(H, "out", "slice7")
SPLITS = json.load(open(os.path.join(H, "slice7", "splits.json")))
JEV = 0.042e-6


def cost(files, prefixes):
    g = j = 0.0
    n = 0
    for f in files:
        if not os.path.exists(f):
            continue
        for l in open(f):
            u = json.loads(l)
            if not any(u.get("tech", "").startswith(p) for p in prefixes):
                continue
            if u.get("api") == "vercel":
                g += u.get("dollars") or 0
            elif u.get("api") == "jev":
                j += (u.get("input_tokens") or 0) * JEV
                n += 1
    return g, j, n


res = {}
for split, arms in (("dev", ["jev-r0", "jev-r1", "jev-r2", "jev-r3"]), ("heldout", ["jev-r3"]), ("heldout-aisdk", ["jev-r3"])):
    pre = SPLITS[split]
    rep = cost([os.path.join(S6, s, "rep", "central", "usage.jsonl") for s in ("dev", "heldout")], pre)
    sh = cost([os.path.join(S6, s, "shared-all", "central", "usage.jsonl") for s in ("dev", "heldout")], pre)
    r = {"rep": round(rep[0] + rep[1], 5), "rep_gateway": round(rep[0], 5), "rep_jev": round(rep[1], 5),
         "shared_extraction": round(sh[0] + sh[1], 5), "shared_gateway": round(sh[0], 5), "shared_label_jev": round(sh[1], 5)}
    for arm in arms:
        rel = cost([os.path.join(S7, split, arm, "central", "usage.jsonl")], pre)
        total = sh[0] + sh[1] + rel[0] + rel[1]
        r[arm] = {"relevance_jev": round(rel[1], 5), "relevance_calls": rel[2], "relevance_gateway_fallback": round(rel[0], 5),
                  "design_total": round(total, 5), "saving_vs_rep": round(1 - total / (rep[0] + rep[1]), 3)}
    res[split] = r
    print(split, json.dumps(r))
json.dump(res, open(os.path.join(S7, "cost.json"), "w"), indent=1)
