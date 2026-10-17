"""Slice 4 compression arms (PREREG.md, "Compression arms"): fit on dev, score held-out once, compare with Jev J1, cost.
No model calls. Writes out/slice4/compress-report.json.

  python3 eval/select/slice4/analyze_compress.py
"""
import json
import os

import analyze as A

ARMS = {
    "JQ1 v1": ("jev-dev-qv1", "jev-heldout-qv1"),
    "JQ2 v2": ("jev-dev-qv2", "jev-heldout-qv2"),
    "JQ3 v3": ("jev-dev-qv3", "jev-heldout-qv3"),
    "JS v3+lean": ("jev-dev-qv3-slean", "jev-heldout-qv3-slean"),
    "Clef base (slice 4)": ("clef-dev", "clef-heldout"),
    "CF-Q Clef v3": ("clef-dev-qv3", "clef-heldout-qv3"),
    "H hybrid (post-hoc)": ("jev-dev-qh", "jev-heldout-qh"),
}
BASE = ("Jev (J1)", "jev-dev", "jev-heldout-run1")
FLOORS = (("breaking recall", "breaking_recall"), ("benefit-vs-none recall", "benefit_recall"), ("actionable recall (yes)", "actionable_recall"))
SECONDARY = ("change_type accuracy", "removal+deprecation recall")


def main():
    labels_path = os.path.join(A.OUT, "adjudicated-records.json")
    labels = A.rj(labels_path)
    out = {"arms": {}}
    rows = [BASE] + [(n, d, h) for n, (d, h) in ARMS.items()]
    for name, dv, hv in rows:
        if not os.path.exists(os.path.join(A.RUNS, hv, "answers.json")):
            continue
        f = A.fit(dv)
        ans = A.rj(os.path.join(A.RUNS, hv, "answers.json"))
        arm = {"fit": f}
        for tag, bt, nt in (("fit", f["BREAKING_P"], f["BENEFIT_P"]), ("05", 0.5, 0.5)):
            pred = A.to_pred(ans, bt, nt)
            path = os.path.join(A.RUNS, hv, "pred-%s.json" % tag)
            json.dump(pred, open(path, "w"), indent=1)
            m = A.metrics(pred, labels)
            m["answered"] = len(pred) / len(labels)
            arm["heldout_" + tag] = m
        meta = A.rj(os.path.join(A.RUNS, hv, "meta.json"))
        per = meta["dollars"] / meta["units"]
        arm["cost"] = {"per_record": per, "input_per_record": meta["input_per_record"], "run_dollars": meta["dollars"],
                       "tech_year_mean": per * A.R_MEAN, "tech_year_max": per * A.R_MAX,
                       "fleet": [per * A.R_MEAN * n for n in (1e4, 5e4, 2e5)]}
        out["arms"][name] = arm
    j1 = os.path.join(A.RUNS, BASE[2])
    j2 = os.path.join(A.RUNS, "jev-heldout-run2")
    jm = out["arms"][BASE[0]]["heldout_fit"]
    for name, arm in out["arms"].items():
        if name == BASE[0]:
            continue
        hv = dict((n, h) for n, _, h in rows)[name]
        res, txt = A.compare(os.path.join(j1, "pred-fit.json"), os.path.join(A.RUNS, hv, "pred-fit.json"), labels_path)
        res05, _ = A.compare(os.path.join(j1, "pred-05.json"), os.path.join(A.RUNS, hv, "pred-05.json"), labels_path)
        res2, _ = A.compare(os.path.join(j2, "pred-fit.json"), os.path.join(A.RUNS, hv, "pred-fit.json"), labels_path)
        arm["vs_J1"], arm["vs_J1_at_05"], arm["vs_J2"] = res, res05, res2
        why = []
        m = arm["heldout_fit"]
        for cname, key in FLOORS:
            if m[key] < jm[key] - 0.05:
                why.append("%s %.1f vs J1 %.1f (> 5 pts below)" % (key, 100 * m[key], 100 * jm[key]))
            if res[cname]["ci"][1] < 0:
                why.append("%s significantly worse" % cname)
        for cname in SECONDARY:
            if res[cname]["ci"][1] < 0:
                why.append("%s significantly worse" % cname)
        arm["pass"], arm["why"] = not why, why
    json.dump(out, open(os.path.join(A.OUT, "compress-report.json"), "w"), indent=1, default=str)
    pc = lambda v: "%.1f" % (100 * v)
    print("%-14s %5s %5s | %5s %5s %5s | %5s %5s %5s %5s | %6s %8s %7s | %s" % ("arm", "BP", "BnP", "bR", "bnR", "aR", "bPrec", "bnPrec", "ct", "obl", "in/rec", "$/tyr", "10k", "verdict"))
    for name, arm in out["arms"].items():
        m, f, c = arm["heldout_fit"], arm["fit"], arm["cost"]
        print("%-14s %5.2f %5.2f | %5s %5s %5s | %5s %5s %5s %5s | %6.0f %8.4f %7.0f | %s" % (
            name, f["BREAKING_P"], f["BENEFIT_P"], pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]),
            pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"]), pc(m["obligation_recall"]),
            c["input_per_record"], c["tech_year_mean"], c["fleet"][0],
            "baseline" if name == BASE[0] else ("PASS" if arm["pass"] else "FAIL: " + "; ".join(arm["why"]))))
    print("\nat 0.5:")
    for name, arm in out["arms"].items():
        m = arm["heldout_05"]
        print("%-14s bR %5s bnR %5s aR %5s | bP %5s bnP %5s ct %5s" % (name, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"])))
    print("\npaired diffs vs J1 (fitted):")
    for name, arm in out["arms"].items():
        if "vs_J1" in arm:
            print("%-14s " % name + " | ".join("%s %+.1f [%+.1f,%+.1f]" % (k.split(" (")[0], 100 * v["diff"], 100 * v["ci"][0], 100 * v["ci"][1]) for k, v in arm["vs_J1"].items() if k in dict(FLOORS) or k in SECONDARY))


if __name__ == "__main__":
    main()
