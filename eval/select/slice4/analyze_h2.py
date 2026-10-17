"""Confirm H on H2 (PREREG.md): breaking recall and precision at the live 0.5 threshold for J1, H, JQ1 (and SubQ Snap) on the H2
units, paired against J1 with score.py's section-cluster bootstrap and exact McNemar. Stdlib only.

    python3 analyze_h2.py [--json OUT]
"""
import argparse, importlib.util, json, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score", os.path.join(HERE, "..", "holdout", "score.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)
OUT4 = os.path.join(HERE, "..", "out", "slice4")
# arm -> (run, breaking threshold). S/S20: SubQ Snap on the pipeline's wording at the live 0.5 and at its dev-fitted 0.20.
RUNS = {"J1": ("jev-heldout2", 0.5), "H": ("jev-heldout2-qh", 0.5), "JQ1": ("jev-heldout2-qv1", 0.5), "S": ("subq-heldout2", 0.5), "S20": ("subq-heldout2", 0.20)}
OBLIG = {"removal", "deprecation"}


def load():
    units = {u["id"]: u for u in sc.rj(os.path.join(OUT4, "h2-units.json"))["units"]}
    preds = {}
    for arm, (run, P) in RUNS.items():
        if not os.path.exists(os.path.join(OUT4, "runs", run, "answers.json")):
            continue
        ans = sc.rj(os.path.join(OUT4, "runs", run, "answers.json"))
        preds[arm] = {}
        for uid in units:
            a = ans.get(uid)
            if not a:
                preds[arm][uid] = None
                continue
            q = a["answers"]
            preds[arm][uid] = {"breaking": q["breaking"]["probabilities"]["yes"] >= P, "change_type": q["change_type"]["choice"]}
    return units, preds


def recall(ids, pred, units):
    pos = [i for i in ids if units[i]["breaking"]]
    return sum(bool(pred[i] and pred[i]["breaking"]) for i in pos) / len(pos) if pos else float("nan")


def precision(ids, pred, units):
    yes = [i for i in ids if pred[i] and pred[i]["breaking"]]
    return sum(units[i]["breaking"] for i in yes) / len(yes) if yes else float("nan")


def oblig(ids, pred, units):
    pos = [i for i in ids if units[i]["obligation"]]
    return sum(bool(pred[i] and pred[i]["change_type"] in OBLIG) for i in pos) / len(pos) if pos else float("nan")


def ctype(ids, pred, units):
    return sum(bool(pred[i] and pred[i]["change_type"] in units[i]["change_types"]) for i in ids) / len(ids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    a = ap.parse_args()
    units, preds = load()
    ids = sorted(units)
    clusters = {i: units[i]["section"] for i in ids}
    out = {"n": len(ids), "breaking": sum(units[i]["breaking"] for i in ids), "obligation": sum(units[i]["obligation"] for i in ids),
           "sections": len(set(clusters.values())), "unanswered": {k: sum(v[i] is None for i in ids) for k, v in preds.items()}, "arms": {}, "vs_J1": {}}
    for arm, p in preds.items():
        out["arms"][arm] = {"breaking_recall": recall(ids, p, units), "breaking_precision": precision(ids, p, units),
                            "predicted_breaking": sum(bool(p[i] and p[i]["breaking"]) for i in ids),
                            "obligation_recall": oblig(ids, p, units), "change_type_agreement": ctype(ids, p, units)}
    j = preds["J1"]
    pos = [i for i in ids if units[i]["breaking"]]
    neg = [i for i in ids if not units[i]["breaking"]]
    obl = [i for i in ids if units[i]["obligation"]]
    for arm in [x for x in preds if x != "J1"]:
        b = preds[arm]
        side = lambda s: j if s == "a" else b
        print("== %s vs J1 (A = J1, B = %s; section-cluster bootstrap)" % (arm, arm))
        rng = random.Random(20261016)
        r = {}
        hit = lambda p: {i: bool(p[i] and p[i]["breaking"]) == units[i]["breaking"] for i in ids}
        ca, cb = hit(j), hit(b)
        # McNemar on breaking refs (recall side) and on non-breaking refs (false positives, the precision side).
        r["breaking_recall"] = sc.paired("breaking recall @0.5", pos, ca, cb, lambda s, x: recall(s, side(x), units), rng, clusters)
        r["breaking_precision"] = sc.paired("breaking precision @0.5", ids, ca, cb, lambda s, x: precision(s, side(x), units), rng, clusters)
        r["false_positive_mcnemar"] = sc.paired("non-breaking correct", neg, ca, cb, lambda s, x: 1 - sum(bool(side(x)[i] and side(x)[i]["breaking"]) for i in s) / len(s), rng, clusters)
        co = lambda p: {i: bool(p[i] and p[i]["change_type"] in OBLIG) for i in ids}
        r["obligation_recall"] = sc.paired("obligation recall (descr.)", obl, co(j), co(b), lambda s, x: oblig(s, side(x), units), rng, clusters)
        ct = lambda p: {i: bool(p[i] and p[i]["change_type"] in units[i]["change_types"]) for i in ids}
        r["change_type_agreement"] = sc.paired("change_type agreement (descr.)", ids, ct(j), ct(b), lambda s, x: ctype(s, side(x), units), rng, clusters)
        rr, rp = r["breaking_recall"]["ci"], r["breaking_precision"]["ci"]
        r["pass"] = rr[1] >= 0 and rp[1] >= 0
        print("  PASS" if r["pass"] else "  FAIL")
        out["vs_J1"][arm] = {k: (dict(v, ci=list(v["ci"])) if isinstance(v, dict) else v) for k, v in r.items()}
    print(json.dumps({k: out[k] for k in ("n", "breaking", "obligation", "sections", "unanswered")}))
    for arm, m in out["arms"].items():
        print("%-4s " % arm + "  ".join("%s %.1f" % (k, 100 * v) if isinstance(v, float) else "%s %d" % (k, v) for k, v in m.items()))
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(out, fh, indent=1)


if __name__ == "__main__":
    main()
