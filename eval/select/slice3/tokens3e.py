"""Slice 3e: tokens per record and per technology-year (PREREG.md "Slice 3e", Tokens), and the daily projection at 20k
technologies against the 2.5M/day complimentary allowance. cost3.py's worst-case formula in tokens; no model calls.

    python3 tokens3e.py RUN_DIR[=REF_RUN_DIR]...   (REF: the gpt-6-luna run on the same set, for the records scale)

Writes tokens.json in the slice's out directory (two levels above the first RUN_DIR). Slice 3f adds the combined free
headroom: technologies served free = 2.5M x 365 / the run's tokens per technology-year + 250k x 365 / gpt-6-luna's
(LUNA6_TECH_YEAR, gpt-6-luna's own complimentary group), the rest at gpt-6-luna flex.
"""
import json, os, sys

MEAN = dict(N=6460, c=17.5, R=114.6)
P_A, P_B, O_A = 597, 874, 85
TECHS, CAP = 20_000, 2_500_000
LUNA_FLEX_REPLAY = 0.0051    # slice 3d production replay, A+B $/technology-year at gpt-6-luna flex
LUNA_FLEX_WORST = 0.0192 / 2  # slice 3b worst case at list, flex = half
LUNA6_CAP = 250_000          # gpt-6-luna's separate complimentary group (slice 3f)
LUNA6_TECH_YEAR = 81_000     # gpt-6-luna low, tokens per technology-year, the larger of H1/H2 (RESULTS-3e.md)


def tokens(run, ref):
    comb = os.path.join(run, "meta.combined.json")  # a run continued from another run's cache (M5r)
    m = json.load(open(comb if os.path.exists(comb) else os.path.join(run, "meta.json")))
    log = m["chunk_log"]
    needed = sum(1 + (1 if c["records"] > 0 else 0) for c in log if c.get("extract") is None) + sum(1 for c in log if c.get("extract"))
    fails = sum(1 for c in log if c.get("extract"))
    factor = (m["calls"] + 2 * fails) / max(1, needed)
    scale = m["records"] / json.load(open(os.path.join(ref, "meta.json")))["records"] if ref else 1.0
    out_rec = m["output"] / max(1, m["records"])
    inp = factor * (2 * MEAN["N"] + MEAN["R"] * O_A * 1.5 + MEAN["c"] * (P_A + P_B))
    out = factor * MEAN["R"] * scale * out_rec
    year = inp + out
    day = year * TECHS / 365
    share_over = max(0.0, 1 - CAP / day)
    free_techs = CAP * 365 / year + LUNA6_CAP * 365 / LUNA6_TECH_YEAR
    paid_techs = max(0.0, TECHS - free_techs)
    return dict(run=m["runId"], records=m["records"], calls=m["calls"],
                per_record=dict(input=m["input"] / m["records"], cached=m["cached_input"] / m["records"], output=out_rec,
                                reasoning=m["reasoning"] / m["records"], total=(m["input"] + m["output"]) / m["records"]),
                attempt_factor=factor, records_scale=scale, tech_year=dict(input=inp, output=out, total=year),
                per_day_20k=day, cap=CAP, share_over_cap=share_over,
                usd_year_fallback_replay=share_over * LUNA_FLEX_REPLAY * TECHS,
                usd_year_fallback_worst=share_over * LUNA_FLEX_WORST * TECHS, dollars_run=m["dollars"],
                free_techs_combined=free_techs, usd_year_combined_replay=paid_techs * LUNA_FLEX_REPLAY,
                usd_year_combined_worst=paid_techs * LUNA_FLEX_WORST)


if __name__ == "__main__":
    rows = []
    for a in sys.argv[1:]:
        run, _, ref = a.partition("=")
        r = tokens(run, ref or None)
        rows.append(r)
        p = r["per_record"]
        print("%-48s rec %4d | per record in %5.0f (cached %4.0f) out %4.0f (reasoning %3.0f) total %5.0f | tech-yr %6.0f | /day@20k %5.2fM (%.0f%% over 2.5M) | fallback $%.0f-$%.0f/yr" % (
            r["run"], r["records"], p["input"], p["cached"], p["output"], p["reasoning"], p["total"], r["tech_year"]["total"],
            r["per_day_20k"] / 1e6, 100 * r["share_over_cap"], r["usd_year_fallback_replay"], r["usd_year_fallback_worst"]))
        print("%-48s free techs with gpt-6-luna's 250k/day too: %.0f; remaining on Luna flex $%.0f-$%.0f/yr" % (
            "", r["free_techs_combined"], r["usd_year_combined_replay"], r["usd_year_combined_worst"]))
    first = os.path.abspath(sys.argv[1].partition("=")[0])
    json.dump(rows, open(os.path.join(os.path.dirname(os.path.dirname(first)), "tokens.json"), "w"), indent=1)
