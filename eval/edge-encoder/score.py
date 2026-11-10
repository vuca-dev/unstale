"""Edge encoder, stage 4: score encoder runs with slice 4's harness against Jev, unchanged: thresholds fitted on dev,
H1 floor metrics paired against Jev J1 (analyze.py), and H2 breaking recall and precision at 0.5 and at the fitted
threshold (analyze_h2.py). Writes nothing into slice 4's own reports. No model calls.

  SLICE4_OUT=<eval/select/out/slice4> python3 eval/edge-encoder/score.py --tags f25 f50 f100 --out <dir>
"""
import argparse
import contextlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
S4 = os.path.join(HERE, "..", "select", "slice4")
sys.path.insert(0, S4)
import analyze as an  # noqa: E402
import analyze_h2 as h2  # noqa: E402

if os.environ.get("SLICE4_OUT"):
    an.OUT = h2.OUT4 = os.environ["SLICE4_OUT"]
    an.RUNS = os.path.join(an.OUT, "runs")

FLOORS = (("breaking recall", "breaking_recall"), ("benefit-vs-none recall", "benefit_recall"), ("actionable recall (yes)", "actionable_recall"),
          ("breaking accuracy", None), ("benefit-vs-none accuracy", None))  # accuracy: the precision guard (PREREG stage 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tags", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    labels_path = os.path.join(an.OUT, "adjudicated-records.json")
    labels = an.rj(labels_path)
    cands = {"Jev (J1)": ("jev-dev", "jev-heldout-run1"), "Encoder slice 4": ("encoder-dev", "encoder-heldout")}
    cands.update({"Edge " + t: ("edge-%s-dev" % t, "edge-%s-heldout" % t) for t in a.tags})
    rep = {"fits": {}, "h1_fit": {}, "h1_05": {}, "vs_J1": {}, "verdict": {}, "h2": None}
    for name, (dv, hv) in cands.items():
        f = an.fit(dv)
        rep["fits"][name] = f
        ans = an.rj(os.path.join(an.RUNS, hv, "answers.json"))
        for tag, bt, nt in (("fit", f["BREAKING_P"], f["BENEFIT_P"]), ("05", 0.5, 0.5)):
            pred = an.to_pred(ans, bt, nt)
            json.dump(pred, open(os.path.join(an.RUNS, hv, "pred-%s.json" % tag), "w"), indent=1)
            rep["h1_fit" if tag == "fit" else "h1_05"][name] = an.metrics(pred, labels)
    base = os.path.join(an.RUNS, "jev-heldout-run1", "pred-fit.json")
    j = rep["h1_fit"]["Jev (J1)"]
    for name, (dv, hv) in cands.items():
        if name == "Jev (J1)":
            continue
        res, txt = an.compare(base, os.path.join(an.RUNS, hv, "pred-fit.json"), labels_path)
        rep["vs_J1"][name] = res
        open(os.path.join(a.out, "compare-%s.txt" % name.replace(" ", "_")), "w").write(txt)
        m, why = rep["h1_fit"][name], []
        for cname, key in FLOORS:
            ci = res[cname]["ci"]
            if ci[1] < 0:
                what = "%s %.1f vs Jev %.1f" % (key, 100 * m[key], 100 * j[key]) if key else cname
                why.append("%s, significantly worse (CI %+.1f..%+.1f)" % (what, 100 * ci[0], 100 * ci[1]))
        rep["verdict"][name] = {"h1_pass": not why, "why": why}
    # H2: breaking at 0.5 and at each arm's dev-fitted threshold, against J1 at 0.5 (slice 4's confirm protocol).
    h2.RUNS = {"J1": ("jev-heldout2", 0.5), "E4": ("encoder-heldout2", 0.5)} if os.path.exists(os.path.join(an.RUNS, "encoder-heldout2")) else {"J1": ("jev-heldout2", 0.5)}
    for t in a.tags:
        h2.RUNS["%s@05" % t] = ("edge-%s-heldout2" % t, 0.5)
        h2.RUNS["%s@fit" % t] = ("edge-%s-heldout2" % t, rep["fits"]["Edge " + t]["BREAKING_P"])
    buf = io.StringIO()
    sys.argv = ["analyze_h2.py", "--json", os.path.join(a.out, "h2.json")]
    with contextlib.redirect_stdout(buf):
        h2.main()
    open(os.path.join(a.out, "h2.txt"), "w").write(buf.getvalue())
    rep["h2"] = an.rj(os.path.join(a.out, "h2.json"))
    json.dump(rep, open(os.path.join(a.out, "report.json"), "w"), indent=1, default=str)
    pc = lambda v: "-" if v != v else "%.1f" % (100 * v)
    print("H1 at dev-fitted thresholds | bR bnR aR (floor) | bP bnP ct")
    for name, m in rep["h1_fit"].items():
        v = rep["verdict"].get(name)
        print("%-18s %5s %5s %5s | %5s %5s %5s | fit %.2f/%.2f | %s" % (name, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]),
              pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"]), rep["fits"][name]["BREAKING_P"], rep["fits"][name]["BENEFIT_P"],
              "baseline" if v is None else ("PASS" if v["h1_pass"] else "FAIL: " + "; ".join(v["why"]))))
    print("H1 at 0.5")
    for name, m in rep["h1_05"].items():
        print("%-18s %5s %5s %5s | %5s %5s %5s" % (name, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"])))
    print("H2 (breaking):")
    for arm, m in rep["h2"]["arms"].items():
        cmp = rep["h2"]["vs_J1"].get(arm)
        print("%-10s R %5s P %5s pred %d | %s" % (arm, pc(m["breaking_recall"]), pc(m["breaking_precision"]), m["predicted_breaking"],
              "" if cmp is None else ("PASS" if cmp["pass"] else "FAIL") + " R CI %s P CI %s" % (cmp["breaking_recall"]["ci"], cmp["breaking_precision"]["ci"])))


if __name__ == "__main__":
    main()
