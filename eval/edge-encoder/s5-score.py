"""Edge encoder, stage 5 (PREREG.md, "Stage 5, fixed before any stage 5 label exists"): score the encoder at 0.4 / 0.05
and Jev's cached answers at 0.5 / 0.5 and 0.05 / 0.10 against the adjudicated labels (s5-adjudicated.json), with
slice 4's harness (analyze.py: to_pred, metrics, compare; score.py's paired bootstrap). Breaking precision is paired
as analyze_h2.py does it (score.paired over every unit), unclustered like compare. No model calls.

Pass (on A u B, encoder against Jev at 0.5 / 0.5): breaking, benefit-vs-none and actionable recall, breaking
precision and benefit-vs-none accuracy each with a paired 95% CI upper bound >= 0.

  SLICE4_OUT=<eval/select/out/slice4> python3 eval/edge-encoder/s5-score.py --dir <s5 dir>
"""
import argparse
import contextlib
import io
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "select", "slice4"))
import analyze as an  # noqa: E402

sc = an.score
ARMS = {"Encoder 0.4/0.05": ("encoder", 0.4, 0.05), "Jev 0.5/0.5": ("jev", 0.5, 0.5), "Jev 0.05/0.10": ("jev", 0.05, 0.10)}
BASE = "Jev 0.5/0.5"
PASS = (("breaking recall", "breaking recall"), ("benefit-vs-none recall", "benefit-vs-none recall"), ("actionable recall (yes)", "actionable recall"),
        ("breaking precision", "breaking precision"), ("benefit-vs-none accuracy", "benefit-vs-none accuracy"))
SUBSETS = (("A+B", ("A", "B")), ("A", ("A",)), ("B", ("B",)), ("C", ("C",)))


def bprec(ids, pred, labels):
    yes = [i for i in ids if pred.get(i) and pred[i]["breaking"]]
    return sum(bool(labels[i]["breaking"]) for i in yes) / len(yes) if yes else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--labels", default=os.path.join(HERE, "s5-adjudicated.json"))
    a = ap.parse_args()
    out = os.path.join(a.dir, "score")
    os.makedirs(out, exist_ok=True)
    units = an.rj(os.path.join(a.dir, "units.json"))
    labels = an.rj(a.labels)["labels"]
    assert set(labels) == set(units), "labels and units differ"
    answers = {"encoder": {"s5:" + i: c for i, c in an.rj(os.path.join(a.dir, "encoder-answers.json")).items()},
               "jev": {"s5:" + i: {"answers": u["answers"]} for i, u in units.items()}}
    preds = {}
    for arm, (src, bt, nt) in ARMS.items():
        preds[arm] = an.to_pred(answers[src], bt, nt)
    rep, lines = {}, []
    pc = lambda v: "-" if v != v else "%.1f" % (100 * v)
    for sub, strata in SUBSETS:
        ids = sorted(i for i, u in units.items() if u["stratum"] in strata)
        lab = {i: labels[i] for i in ids}
        lp = os.path.join(out, "labels-%s.json" % sub)
        json.dump(lab, open(lp, "w"), indent=1)
        paths = {}
        for arm, p in preds.items():
            paths[arm] = os.path.join(out, "pred-%s-%s.json" % (sub, arm.split()[0].lower() + arm.split()[1].replace("/", "_")))
            json.dump({i: p[i] for i in ids}, open(paths[arm], "w"), indent=1)
        r = {"n": len(ids), "technologies": len({units[i]["tech"] for i in ids}), "positives": {}, "arms": {}, "vs": {}}
        for arm, p in preds.items():
            m = an.metrics({i: p[i] for i in ids}, lab)
            rows = sc.classify_vectors({i: p[i] for i in ids}, lab)
            m["benefit_accuracy"] = sc.prf(rows, "benefit_any")["accuracy"]
            m["breaking_accuracy"] = sc.prf(rows, "breaking")["accuracy"]
            m["actionable_precision"] = sc.prf(rows, "actionable")["precision"]
            m["predicted_breaking"] = sum(p[i]["breaking"] for i in ids)
            r["arms"][arm] = m
        r["positives"] = {"breaking": r["arms"][BASE]["breaking_pos"], "benefit": r["arms"][BASE]["benefit_pos"], "actionable": r["arms"][BASE]["actionable_pos"]}
        for arm in ARMS:
            if arm.startswith("Jev"):
                continue
            for base in (b for b in ARMS if b.startswith("Jev")):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    res, txt = an.compare(paths[base], paths[arm], lp)
                    va, vb = sc.classify_vectors(preds[base], lab), sc.classify_vectors(preds[arm], lab)
                    ca = {i: va[i]["breaking"]["pred"] == va[i]["breaking"]["ref"] for i in ids}
                    cb = {i: vb[i]["breaking"]["pred"] == vb[i]["breaking"]["ref"] for i in ids}
                    side = {"a": preds[base], "b": preds[arm]}
                    res["breaking precision"] = sc.paired("breaking precision", ids, ca, cb, lambda s, k: bprec(s, side[k], lab), random.Random(sc.SEED))
                key = "%s vs %s" % (arm, base)
                r["vs"][key] = {k: dict(v, ci=list(v["ci"])) for k, v in res.items()}
                lines.append("== %s, %s\n%s%s" % (sub, key, txt, buf.getvalue()))
        rep[sub] = r
    v = rep["A+B"]["vs"]["Encoder 0.4/0.05 vs " + BASE]
    why = ["%s CI %+.1f..%+.1f" % (label, 100 * v[k]["ci"][0], 100 * v[k]["ci"][1]) for k, label in PASS if v[k]["ci"][1] < 0]
    rep["verdict"] = {"pass": not why, "fails": why}
    json.dump(rep, open(os.path.join(out, "report.json"), "w"), indent=1)
    open(os.path.join(out, "compare.txt"), "w").write("\n".join(lines))
    for sub, _ in SUBSETS:
        r = rep[sub]
        print("\n%s: %d records, %d technologies, positives %s" % (sub, r["n"], r["technologies"], r["positives"]))
        print("%-18s %6s %6s %6s %6s %6s | %6s %6s %6s %5s" % ("arm", "bR", "bnR", "aR", "bP", "bnAcc", "bAcc", "bnP", "ct", "#brk"))
        for arm, m in r["arms"].items():
            print("%-18s %6s %6s %6s %6s %6s | %6s %6s %6s %5d" % (arm, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["breaking_precision"]),
                  pc(m["benefit_accuracy"]), pc(m["breaking_accuracy"]), pc(m["benefit_precision"]), pc(m["change_type_acc"]), m["predicted_breaking"]))
        for key, res in r["vs"].items():
            print("  %s: " % key + "; ".join("%s %+.1f [%+.1f, %+.1f]" % (label, 100 * res[k]["diff"], 100 * res[k]["ci"][0], 100 * res[k]["ci"][1]) for k, label in PASS)
                  + "; change_type acc %+.1f [%+.1f, %+.1f]" % (100 * res["change_type accuracy"]["diff"], 100 * res["change_type accuracy"]["ci"][0], 100 * res["change_type accuracy"]["ci"][1]))
    print("\nVERDICT (A+B, encoder vs Jev 0.5/0.5):", "PASS" if rep["verdict"]["pass"] else "FAIL: " + "; ".join(why))


if __name__ == "__main__":
    main()
