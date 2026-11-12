""""Same-or-new by rule" (RESULTS.md): merge recall and false merges of a `run-step --step match` output against the
audited verdicts (eval/select/out/slice5/units.json), on either split, with score.py's guides exclusion and its
convention that a merge no audit read counts as a false one; paired against a second output when given.

    python3 rule_score.py heldout|dev INPUT.jsonl NEW.out.jsonl [BASE.out.jsonl]
"""
import json, math, os, re, sys
split, inp, new = sys.argv[1:4]; base = sys.argv[4] if len(sys.argv) > 4 else None
D = json.load(open(os.path.join(os.environ.get("EDGE_PORT_CENTRAL_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "select", "out"), "slice5", "units.json")))
items = {}
for u in D["units"]:
    if u["split"] != split: continue
    it = items.setdefault("%s|%s" % (u["set"], u["key"]), {"set": u["set"], "key": u["key"], "verdicts": {}})
    it["verdicts"][u["candidate"]] = u["verdict"]
for it in items.values(): it["has_same"] = "SAME" in it["verdicts"].values()
keyorder = lambda k: "".join(x.zfill(8) if x.isdigit() else x for x in re.split(r"(\d+)", k))
L = lambda p: [json.loads(l) for l in open(p) if l.strip()]
def merged_of(path):
    own = {i["uid"]: o for i, o in zip(L(inp), L(path))}
    assert len(own) == len(items) and not any("deferred" in o for o in own.values()), (len(own), len(items))
    taken, merged = {}, {}
    for u in sorted(items, key=lambda u: keyorder(items[u]["key"]) if items[u]["set"] == "guides" else ""):
        o = own[u]
        if items[u]["set"] != "guides": merged[u] = o["match"]; continue
        t = taken.setdefault(items[u]["key"].split("#")[0], set())
        ok = [j for j in o["judged"] if j["outcome"] in ("same", "not-best") and j["id"] not in t]
        best = None
        for j in ok:
            if best is None or j["p"] > best["p"]: best = j
        merged[u] = best["id"] if best else None
        if best: t.add(best["id"])
    return merged, own
def metrics(m):
    mm = [u for u in items if m.get(u)]
    v = lambda u: items[u]["verdicts"].get(m[u], "UNAUDITED")
    c = lambda x: sum(1 for u in mm if v(u) == x)
    same = [u for u in items if items[u]["has_same"]]
    rec = [u for u in same if m.get(u) and v(u) == "SAME"]
    fb = c("DIFFERENT") + 0.5 * c("UNSURE") + c("UNAUDITED")
    return "merges %d (same %d, different %d, unsure %d, unaudited %d); recall %d/%d = %.1f%%; false per 100 merges %.1f" % (len(mm), c("SAME"), c("DIFFERENT"), c("UNSURE"), c("UNAUDITED"), len(rec), len(same), 100 * len(rec) / len(same), 100 * fb / len(mm) if mm else 0)
binom = lambda k, n: sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
mc = lambda x, y: 1.0 if not x + y else min(1.0, 2 * binom(min(x, y), x + y))
mn, own = merged_of(new)
sets = sorted({it["set"] for it in items.values()})
print("%s split, %d items (%s)" % (split, len(items), ", ".join("%s %d" % (s, sum(1 for i in items.values() if i["set"] == s)) for s in sets)))
print("  new : " + metrics(mn) + "; by rule %d, judge asked %d" % (sum(1 for o in own.values() if o.get("by") == "rule"), sum(1 for o in own.values() if o.get("by") != "rule" and any(j["outcome"] != "unasked" for j in o["judged"]))))
if base:
    mb, bown = merged_of(base)
    print("  base: " + metrics(mb) + "; judge asked %d" % sum(1 for o in bown.values() if any(j["outcome"] != "unasked" for j in o["judged"]) or o.get("failed")))
    v = lambda d, u: items[u]["verdicts"].get(d[u], "UNAUDITED") if d.get(u) else None
    same = [u for u in items if items[u]["has_same"]]
    bo = sum(v(mb, u) == "SAME" and v(mn, u) != "SAME" for u in same); no = sum(v(mn, u) == "SAME" and v(mb, u) != "SAME" for u in same)
    false = lambda d, u: bool(d.get(u)) and v(d, u) != "SAME"
    fb = sum(false(mb, u) and not false(mn, u) for u in items); fn = sum(false(mn, u) and not false(mb, u) for u in items)
    print("  paired: true merges only base %d, only new %d (McNemar p %.2f); false merges only base %d, only new %d (p %.2f); items decided differently %d" % (bo, no, mc(bo, no), fb, fn, mc(fb, fn), sum(1 for u in items if mb.get(u) != mn.get(u))))
    for u in items:
        if mb.get(u) != mn.get(u): print("     ", u, "base:", mb.get(u), v(mb, u), "| new:", mn.get(u), v(mn, u))
