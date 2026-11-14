"""Port parity scoring (PREREGISTRATION.md): the client's `run-step` output scored with central's own scorers, beside
central's stored run for the same route, with the paired difference and its 95% interval. No model call.

    python3 score.py extract h1|h2 CLIENT.out.jsonl --central RUN_DIR [--also RUN_DIR ...] --json OUT
    python3 score.py labels  h1|h2 CLIENT.out.jsonl --central ANSWERS.json --json OUT [--exact]
    python3 score.py match   CLIENT.out.jsonl --central ROWS.json [--also ROWS.json ...] --json OUT [--exact]

Scorers reused unchanged: eval/select/holdout/score.py, slice3/stats.py and stats3b.py (extraction), slice4/analyze.py
and analyze_h2.py (labels). Matching follows slice5/score5.mts (`metrics`, the guides set's exclusion, McNemar and
its bootstrap). --exact also requires every item's decision to equal central's (the replayed-answer cells).
"""
import argparse, importlib.util, json, math, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SELECT = os.path.join(HERE, "..", "select")
INPUTS = os.path.join(HERE, "out", "inputs")
WORK = os.path.join(HERE, "out", "scored")


def mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def lines(p):
    return [json.loads(l) for l in open(p) if l.strip()]


def pct(x):
    return None if x != x else round(100 * x, 1)


# ---- Extraction ----
def extract(a):
    out = lines(a.client)
    bad = [o for o in out if "deferred" in o and "incoming" not in o]
    if bad:
        sys.exit("the run stopped: %s" % bad[0])
    run = os.path.join(WORK, os.path.basename(a.client).replace(".out.jsonl", ""))
    os.makedirs(run, exist_ok=True)
    incoming = [r for o in out for r in o["incoming"]]
    json.dump(incoming, open(os.path.join(run, "incoming.json"), "w"), indent=1)
    res = {"client": {"events": len(out), "records": len(incoming), "failed_calls": sum(o.get("failed", 0) for o in out)}}
    cen = [a.central] + (a.also or [])
    if a.set == "h1":
        st = mod("stats", os.path.join(SELECT, "slice3", "stats.py"))
        manifest = st.sc.load_manifest(st.sc.NOTES)
        keys = ("pooled_excl_unsure", "macro_excl_unsure", "breaking", "precision", "records")
        table = lambda r: {k: v for k, v in st.metrics(*st.rows(r, manifest)).items() if k in keys or k.startswith("n_")}
        res["client"].update(table(run))
        res["central"] = {os.path.basename(c.rstrip("/")): table(c) for c in cen}
        res["client_minus_central"] = {os.path.basename(c.rstrip("/")): st.compare(c, run, manifest) for c in cen}
        res["central_runs_against_each_other"] = {"%s minus %s" % (os.path.basename(y), os.path.basename(x)): st.compare(x, y, manifest) for i, x in enumerate(cen) for y in cen[i + 1:]}
    else:
        st = mod("stats3b", os.path.join(SELECT, "slice3", "stats3b.py"))
        keys = ("required_sure", "required", "breaking", "recall", "precision", "records")
        table = lambda r: {k: v for k, v in st.metrics(r).items() if k in keys}
        res["client"].update(table(run))
        res["central"] = {os.path.basename(c.rstrip("/")): table(c) for c in cen}
        res["client_minus_central"] = {os.path.basename(c.rstrip("/")): st.compare(c, run) for c in cen}
        res["central_runs_against_each_other"] = {"%s minus %s" % (os.path.basename(y), os.path.basename(x)): st.compare(x, y) for i, x in enumerate(cen) for y in cen[i + 1:]}
    return res


# ---- Labels ----
def client_labels(a, name):
    """{uid: the client's own labels (its `interpret`)} and {uid: answers}, uid from the input file's order."""
    inp, out = lines(os.path.join(INPUTS, name)), lines(a.client)
    if len(inp) != len(out) or any("deferred" in o for o in out):
        sys.exit("the run stopped or is incomplete: %d of %d lines" % (len(out), len(inp)))
    for i, o in zip(inp, out):
        if i["incoming"]["key"] != o["key"]:
            sys.exit("output order differs from the input's")
    return {i["uid"]: o["labels"] for i, o in zip(inp, out)}, {i["uid"]: o["answers"] for i, o in zip(inp, out)}


def labels(a):
    A = mod("analyze", os.path.join(SELECT, "slice4", "analyze.py"))
    H = mod("analyze_h2", os.path.join(SELECT, "slice4", "analyze_h2.py"))
    lab, ans = client_labels(a, "labels-%s.jsonl" % a.set)
    central = json.load(open(a.central))
    res = {"client_answered": sum(1 for v in lab.values() if v), "n": len(lab),
           "client_models": sorted({v["model"] for v in ans.values() if v}), "central_models": sorted({v["model"] for v in central.values() if v})}
    # The client's labels are its own thresholds' (schema/prompts/thresholds.json: 0.5); central's answers are read at
    # central's production thresholds (0.5), with slice 4's mapping.
    mine = lambda v: {"breaking": v["breaking"], "benefit": v["benefit"], "change_type": v["change_type"], "actionable": v["surface"] != "runtime_internal"}
    if a.set == "h1":
        pc = {u.split(":", 1)[1]: mine(v) for u, v in lab.items() if v}
        pa = A.to_pred(central, 0.5, 0.5)
        os.makedirs(WORK, exist_ok=True)
        tag = os.path.basename(a.client).replace(".out.jsonl", "")
        fa, fc = os.path.join(WORK, tag + ".central-pred.json"), os.path.join(WORK, tag + ".client-pred.json")
        json.dump(pa, open(fa, "w"))
        json.dump(pc, open(fc, "w"))
        labels_path = os.path.join(A.OUT, "adjudicated-records.json")
        ref = A.rj(labels_path)
        keep = ("breaking_recall", "breaking_precision", "benefit_recall", "benefit_precision", "actionable_recall", "actionable_precision", "change_type_acc", "obligation_recall")
        res["central"] = {k: v for k, v in A.metrics(pa, ref).items() if k in keep}
        res["client"] = {k: v for k, v in A.metrics(pc, ref).items() if k in keep}
        cmp, _ = A.compare(fa, fc, labels_path)
        res["client_minus_central"] = {k: dict(v, ci=list(v["ci"])) for k, v in cmp.items()}
        res["records_with_a_different_label"] = sorted(k for k in set(pa) | set(pc) if pa.get(k) != pc.get(k))
    else:
        units = {u["id"]: u for u in A.rj(os.path.join(H.OUT4, "h2-units.json"))["units"]}
        ids = sorted(units)
        j = {u: ({"breaking": c["answers"]["breaking"]["probabilities"]["yes"] >= 0.5, "change_type": c["answers"]["change_type"]["choice"]} if c else None) for u, c in central.items()}
        b = {u: ({"breaking": v["breaking"], "change_type": v["change_type"]} if v else None) for u, v in lab.items()}
        clusters = {i: units[i]["section"] for i in ids}
        pos = [i for i in ids if units[i]["breaking"]]
        side = lambda s: j if s == "a" else b
        hit = lambda p: {i: bool(p.get(i) and p[i]["breaking"]) == units[i]["breaking"] for i in ids}
        rng = random.Random(20261016)
        res["central"] = {"breaking_recall": H.recall(ids, j, units), "breaking_precision": H.precision(ids, j, units), "obligation_recall": H.oblig(ids, j, units)}
        res["client"] = {"breaking_recall": H.recall(ids, b, units), "breaking_precision": H.precision(ids, b, units), "obligation_recall": H.oblig(ids, b, units)}
        r = {"breaking recall": H.sc.paired("breaking recall", pos, hit(j), hit(b), lambda s, x: H.recall(s, side(x), units), rng, clusters),
             "breaking precision": H.sc.paired("breaking precision", ids, hit(j), hit(b), lambda s, x: H.precision(s, side(x), units), rng, clusters)}
        res["client_minus_central"] = {k: dict(v, ci=list(v["ci"])) for k, v in r.items()}
        res["records_with_a_different_label"] = sorted(i for i in ids if j.get(i) != b.get(i))
    if a.exact:
        # Replayed answers: every probability the client kept must be central's too.
        def far(x, y):
            if x is None or y is None:
                return x is not y
            return any(x[q]["choice"] != y[q]["choice"] or any(abs(p - y[q]["probabilities"][o]) > 1e-12 for o, p in x[q]["probabilities"].items()) for q in x)
        get = lambda d, u: (d.get(u) or {}).get("answers")
        res["answers_differing_from_central"] = sum(1 for u in central if far(get(central, u), get(ans, u)))
        # serde_json reads a few probabilities one unit in the last place away from the text (0.45999999999999996 as 0.46).
        res["answers_differing_only_in_the_last_digit"] = sum(1 for u in central if get(central, u) != get(ans, u) and not far(get(central, u), get(ans, u)))
        res["exact"] = not res["answers_differing_from_central"] and not res["records_with_a_different_label"]
    return res


# ---- Matching ----
R = {"nuxt": 794, "guides": 73}  # score5.mts: records behind the held-out sets
keyorder = lambda k: "".join(x.zfill(8) if x.isdigit() else x for x in re.split(r"(\d+)", k))


def binom_cdf(k, n, p=0.5):
    return sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k + 1))


def exact_ci(k, n):
    if not n:
        return [0.0, 1.0]

    def solve(f):
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if f(mid) > 0 else (lo, mid)
        return (lo + hi) / 2
    lower = 0.0 if k == 0 else solve(lambda p: 1 if 1 - binom_cdf(k - 1, n, p) < 0.025 else -1)
    upper = 1.0 if k == n else solve(lambda p: 1 if binom_cdf(k, n, p) > 0.025 else -1)
    return [lower, upper]


def match_items():
    D = json.load(open(os.path.join(SELECT, "out", "slice5", "units.json")))
    items = {}
    for u in D["units"]:
        if u["split"] != "heldout":
            continue
        it = items.setdefault("%s|%s" % (u["set"], u["key"]), {"set": u["set"], "key": u["key"], "verdicts": {}})
        it["verdicts"][u["candidate"]] = u["verdict"]
    for it in items.values():
        it["has_same"] = "SAME" in it["verdicts"].values()
    return items


def match_metrics(items, merged):
    m = [u for u in items if merged.get(u)]
    v = lambda u: items[u]["verdicts"].get(merged[u], "UNAUDITED")
    c = lambda x: sum(1 for u in m if v(u) == x)
    S, Dn, U, un = c("SAME"), c("DIFFERENT"), c("UNSURE"), c("UNAUDITED")
    same = [u for u in items if items[u]["has_same"]]
    rec = [u for u in same if merged.get(u) and v(u) == "SAME"]
    Rn = sum(R[s] for s in {items[u]["set"] for u in items})
    return {"merges": len(m), "SAME": S, "DIFFERENT": Dn, "UNSURE": U, "unaudited": un,
            # score5.mts `false_bound`: a merge no audit read counts as a false one.
            "false_per_100": 100 * (Dn + 0.5 * U + un) / len(m) if m else 0.0, "false_ci95": [100 * x for x in exact_ci(Dn + un + U, len(m))],
            "same_items": len(same), "recalled": len(rec), "recall": len(rec) / len(same), "duplicates_per_100": 100 * (len(same) - len(rec)) / Rn}


def match_paired(items, a, b):
    """b minus a: score5.mts's comparison (McNemar on recall and on false merges; bootstrap of the recall difference)."""
    v = lambda d, u: items[u]["verdicts"].get(d[u], "UNAUDITED") if d.get(u) else None
    same = [u for u in sorted(items) if items[u]["has_same"]]
    ra, rb = [v(a, u) == "SAME" for u in same], [v(b, u) == "SAME" for u in same]
    false = lambda d, u: bool(d.get(u)) and v(d, u) != "SAME"
    rng = random.Random(12345)
    n, ds = len(same), []
    for _ in range(10000):
        s = 0
        for _ in range(n):
            j = rng.randrange(n)
            s += rb[j] - ra[j]
        ds.append(s / n)
    ds.sort()
    bo, co = sum(x and not y for x, y in zip(ra, rb)), sum(y and not x for x, y in zip(ra, rb))
    fa, fb = sum(false(a, u) and not false(b, u) for u in items), sum(false(b, u) and not false(a, u) for u in items)
    p = lambda x, y: 1.0 if not x + y else min(1.0, 2 * binom_cdf(min(x, y), x + y))
    return {"recall_diff": (sum(rb) - sum(ra)) / n, "recall_diff_ci95": [ds[250], ds[9750]], "recall_central_only": bo, "recall_client_only": co, "recall_mcnemar_p": p(bo, co),
            "false_central_only": fa, "false_client_only": fb, "false_mcnemar_p": p(fa, fb), "items_decided_differently": sum(1 for u in items if a.get(u) != b.get(u))}


def match(a):
    items = match_items()
    inp, out = lines(os.path.join(INPUTS, "match-heldout.jsonl")), lines(a.client)
    if len(inp) != len(out) or any("deferred" in o for o in out):
        sys.exit("the run stopped or is incomplete: %d of %d lines" % (len(out), len(inp)))
    own = {}
    for i, o in zip(inp, out):
        if i["incoming"]["key"] != o["key"]:
            sys.exit("output order differs from the input's")
        own[i["uid"]] = o
    # The guides set's exclusion, as score5.mts applies it to every arm: within one guide, in key order, a record that
    # took an item is no candidate for the next; the item then takes its next-best unblocked candidate.
    taken, merged = {}, {}
    for u in sorted(items, key=lambda u: keyorder(items[u]["key"]) if items[u]["set"] == "guides" else ""):
        o = own[u]
        if items[u]["set"] != "guides":
            merged[u] = o["match"]
            continue
        t = taken.setdefault(items[u]["key"].split("#")[0], set())
        ok = [j for j in o["judged"] if j["outcome"] in ("same", "not-best") and j["id"] not in t]
        best = None
        for j in ok:
            if best is None or j["p"] > best["p"]:
                best = j
        merged[u] = best["id"] if best else None
        if best:
            t.add(best["id"])
    res = {"n": len(items), "client_failed": sum(1 for o in out if o.get("failed")), "client": match_metrics(items, merged),
           "client_merges_before_the_guide_exclusion": sum(1 for o in out if o.get("match")), "central": {}, "client_minus_central": {}}
    for path in [a.central] + (a.also or []):
        rows = json.load(open(path))
        name = os.path.basename(path).replace(".json", "")
        pub = {u: r["published"] for u, r in rows.items()}
        res["central"][name] = match_metrics(items, pub)
        res["client_minus_central"][name] = match_paired(items, pub, merged)
        if a.exact and path == a.central:
            # Replayed answers: the client's pick must be production's pick on every item, candidate by candidate.
            # (A request left with no question is never sent: run-step prints no candidates for it, where central's
            # pick lists each as "unasked".)
            asked = lambda js: [(j["id"], j["outcome"]) for j in js if j["outcome"] != "unasked"] or []
            diff = [u for u, r in rows.items() if (r["production"] or {}).get("match") != own[u]["match"]
                    or (own[u]["judged"] and [(j["id"], j["outcome"]) for j in r["production"]["judged"]] != [(j["id"], j["outcome"]) for j in own[u]["judged"]])
                    or (not own[u]["judged"] and asked((r["production"] or {}).get("judged", [])))]
            res["items_differing_from_production_pick"] = diff
            res["exact"] = not diff
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=("extract", "labels", "match"))
    ap.add_argument("rest", nargs="+")
    ap.add_argument("--central", required=True)
    ap.add_argument("--also", action="append")
    ap.add_argument("--json")
    ap.add_argument("--exact", action="store_true")
    a = ap.parse_args()
    if a.step == "match":
        (a.client,) = a.rest
        res = match(a)
    else:
        a.set, a.client = a.rest
        res = extract(a) if a.step == "extract" else labels(a)
    text = json.dumps(res, indent=1, default=lambda o: list(o) if isinstance(o, (tuple, set)) else str(o))
    if a.json:
        open(a.json, "w").write(text + "\n")
    print(text if len(text) < 6000 else text[:6000] + "\n…")


if __name__ == "__main__":
    main()
