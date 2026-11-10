"""PREREG addendum 1: gpt-6-luna chat on step D read on its choices. No model calls.

    python3 eval/provider-matrix/analyze_choice.py

Arms: `choice_openai_gpt-6-luna` (the fresh confirmatory run, `run4.mts --cand choice:openai/gpt-6-luna`) and
`choicefrom_vercel_openai_gpt-6-luna` (descriptive: the first run's answers with every probability set to its choice).
Both carry probability 1 for the choice, so slice 14's fit returns a threshold equivalent to the choice. The rule adds
slice 4's guard (change_type accuracy, removal + deprecation recall) and the secondary comparison against Jev at 0.5.
"""
import importlib.util, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("pm_analyze_d", os.path.join(HERE, "analyze_d.py"))  # not "analyze_d": slice 14 has one
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)

ARMS = ["choice_openai_gpt-6-luna", "choicefrom_vercel_openai_gpt-6-luna"]


def ci(r):
    return "%+.1f [%+.1f, %+.1f]" % (100 * (r["b"] - r["a"]) if "a" in r and "b" in r else float("nan"), 100 * r["ci"][0], 100 * r["ci"][1])


def main():
    for arm in [a for a in ARMS if os.path.exists(os.path.join(P.D.A.RUNS, a + "-heldout", "answers.json"))]:
        P.main([arm])
        dest = os.path.join(P.OUT, "d-%s.json" % arm)
        rep = json.load(open(dest))
        why = list(rep["floor_why"])
        for k in ("change_type accuracy", "removal+deprecation recall"):
            if rep["h1_vs_jev_fit"][k]["ci"][1] < 0:
                why.append("H1 guard: %s significantly worse" % k)
        sec = []
        for cname, key in (("breaking recall", "breaking_recall"), ("benefit-vs-none recall", "benefit_recall"), ("actionable recall (yes)", "actionable_recall")):
            if rep["h1"]["snap_fit"][key] < rep["h1"]["jev_05"][key] - 0.05 or rep["h1_vs_jev_05"][cname]["ci"][1] < 0:
                sec.append(cname)
        rep["choice_rule"] = {"pass": not why, "why": why, "secondary_vs_jev_05_pass": not sec, "secondary_fails": sec}
        json.dump(rep, open(dest, "w"), indent=1)
        print("   RULE (with guard): %s %s | secondary vs Jev@0.5: %s %s" % ("PASS" if not why else "FAIL", why, "pass" if not sec else "fail", sec))
        for k in ("breaking recall", "benefit-vs-none recall", "actionable recall (yes)", "change_type accuracy", "removal+deprecation recall"):
            print("   H1 %-26s vs Jev fit CI %s | vs Jev 0.5 CI %s" % (k, [round(100 * x, 1) for x in rep["h1_vs_jev_fit"][k]["ci"]], [round(100 * x, 1) for x in rep["h1_vs_jev_05"][k]["ci"]]))


if __name__ == "__main__":
    main()
