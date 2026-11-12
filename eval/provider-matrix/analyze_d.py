"""Step D for the provider matrix (PREREG.md): slice 14's analysis (slice 4 fit and H1 rule, H2 rule) for each arm
against Jev v1, plus the cost from each arm's measured $ per H1 record (output and reasoning included, which slice 14's
input-only cost leaves out for chat arms). No model calls.

    python3 eval/provider-matrix/analyze_d.py [ARM ...]     (default: decisions and the two chat arms)

Writes eval/select/out/provider-matrix/d-<arm>.json.
"""
import contextlib, io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
S14 = os.path.join(HERE, "..", "select", "slice14")
sys.path.insert(0, S14)
import analyze_d as D  # noqa: E402  (slice 14, which imports slice 4's analyze and analyze_h2)

OUT = os.path.join(HERE, "..", "select", "out", "provider-matrix")
ARMS = {"decisions": 0.10, "vercel_anthropic_claude-haiku-5.5": None, "vercel_openai_gpt-6-luna": None}


def main(arms):
    os.makedirs(OUT, exist_ok=True)
    for arm in arms:
        dest = os.path.join(OUT, "d-%s.json" % arm)
        argv = ["analyze_d.py", "--arm", arm, "--json", dest] + (["--price", str(ARMS[arm])] if ARMS.get(arm) else [])
        sys.argv = argv
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            D.main()
        rep = json.load(open(dest))
        meta = D.A.rj(os.path.join(D.A.RUNS, arm + "-heldout", "meta.json"))
        per = meta["dollars_per_record"]
        rep["cost_measured"] = {"dollars_per_record": per, "tech_year_mean": per * D.A.R_MEAN, "tech_year_max": per * D.A.R_MAX,
                                "input_per_record": meta["input_per_record"], "output_per_record": meta["output_per_record"],
                                "reasoning_per_record": meta["reasoning_per_record"], "parse_rate": meta["parse_rate"]}
        json.dump(rep, open(dest, "w"), indent=1)
        h1 = rep["h1"]
        pc = lambda v: "%.1f" % (100 * v)
        print("== %s: floor %s %s" % (arm, "PASS" if rep["floor_pass"] else "FAIL", rep["floor_why"]))
        for k in ("jev_fit", "snap_fit", "jev_05", "snap_05"):
            m = h1[k]
            print("  H1 %-8s breaking R %s P %s | benefit R %s P %s | actionable R %s | change_type %s" % (
                k.replace("snap", "arm"), pc(m["breaking_recall"]), pc(m["breaking_precision"]), pc(m["benefit_recall"]), pc(m["benefit_precision"]), pc(m["actionable_recall"]), pc(m["change_type_acc"])))
        for cname in ("breaking recall", "benefit-vs-none recall", "actionable recall (yes)"):
            r = rep["h1_vs_jev_fit"][cname]
            print("  H1 vs Jev fit %-24s diff %+.1f CI %s" % (cname, 100 * r.get("diff", float("nan")) if "diff" in r else float("nan"), r["ci"]))
        for tag, r in rep.get("h2", {}).items():
            print("  H2 %s: R %s P %s (Jev %s / %s) CI R %s P %s" % (tag, pc(r["recall"]), pc(r["precision"]), pc(r["jev_recall"]), pc(r["jev_precision"]), r["breaking_recall"]["ci"], r["breaking_precision"]["ci"]))
        c = rep["cost_measured"]
        print("  fit %s | $/record %.6f, $/tech-year mean %.4f max %.3f (in %.0f, out %.0f, reasoning %.0f per record; parse %.3f)" % (
            json.dumps({k: rep["fit"]["snap"][k] for k in ("BREAKING_P", "BENEFIT_P")}), c["dollars_per_record"], c["tech_year_mean"], c["tech_year_max"], c["input_per_record"], c["output_per_record"], c["reasoning_per_record"], c["parse_rate"]))


if __name__ == "__main__":
    main(sys.argv[1:] or list(ARMS))
