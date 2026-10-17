"""Worst-case $ per technology-year per arm (PREREG.md, Decision rule 3). N, c, R, P from `cost.mts` (16 October 2026
store); output per record (reasoning included) and the attempt factor measured on each arm's held-out run.

    python3 cost3.py RUN_DIR... [--luna RUN_DIR] [--out OUT.json]   (default out/slice3/cost.json)
"""
import json, os, sys

PRICES = {  # gateway list, $ per M (prices.json, checked 2026-10-16); input at the uncached rate (worst case)
    "openai/gpt-oss-20b": (0.03, 0.14), "openai/gpt-oss-120b": (0.10, 0.50), "alibaba/qwen3.8-flash": (0.15, 0.47),
    "deepseek/deepseek-v4-flash": (0.13, 0.26), "gpt-5.6-luna": (0.20, 1.20),
    # slice 3b (prices.json, gateway list, base tier)
    "openai/gpt-6-luna": (0.10, 0.50), "openai/gpt-5-nano": (0.05, 0.40), "nvidia/nemotron-3.5-lightning": (0.05, 0.20),
    "alibaba/qwen3.7-flash": (0.03, 0.13), "zai/glm-4.7-flash": (0.07, 0.40)}
MEAN = dict(N=6460, c=17.5, R=114.6)
MAX = dict(N=204131, c=531, R=1092)
P_A, P_B, P_1, O_A = 597, 874, 1452, 85


def main(argv):
    luna = argv[argv.index("--luna") + 1] if "--luna" in argv else None
    dest = argv[argv.index("--out") + 1] if "--out" in argv else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "slice3", "cost.json")
    runs = [r for i, r in enumerate(argv) if r not in ("--luna", "--out") and (i == 0 or argv[i - 1] != "--out")]
    lrec = json.load(open(os.path.join(luna, "meta.json")))["records"] if luna else None
    out = {}
    for run in runs:
        m = json.load(open(os.path.join(run, "meta.json")))
        pi, po = PRICES[m["model"]]
        log = m["chunk_log"]
        needed = sum(1 + (1 if (c["records"] > 0 and m["structure"] == "two-call") else 0) for c in log if c.get("extract") is None) + sum(1 for c in log if c.get("extract"))
        # A failed or truncated chunk costs 3 attempts in production (codex.ts retries an unparseable answer).
        fails = sum(1 for c in log if c.get("extract"))
        factor = (m["calls"] + 2 * fails) / max(1, needed)
        out_per_rec = m["output"] / max(1, m["records"])  # completion tokens, reasoning included
        scale = m["records"] / lrec if lrec else 1.0
        res = {}
        for name, t in (("mean", MEAN), ("max", MAX)):
            R = t["R"] * scale
            if m["structure"] == "two-call":
                inp = 2 * t["N"] + t["R"] * O_A * 1.5 + t["c"] * (P_A + P_B)
            else:
                inp = t["N"] + t["c"] * P_1
            usd = factor * (inp * pi + R * out_per_rec * po) / 1e6
            res[name] = usd
        res.update(attempt_factor=factor, out_per_record=out_per_rec, reasoning=m["reasoning"], records_scale=scale,
                   at_10k=res["mean"] * 1e4, at_50k=res["mean"] * 5e4, at_200k=res["mean"] * 2e5)
        out[m["runId"]] = res
        print("%-55s $/tech-yr mean %.5f  max %.4f  | 10k $%.0f  50k $%.0f  200k $%.0f | out/rec %.0f, attempts x%.2f, R scale %.2f" % (
            m["runId"], res["mean"], res["max"], res["at_10k"], res["at_50k"], res["at_200k"], out_per_rec, factor, scale))
    json.dump(out, open(dest, "w"), indent=1)


if __name__ == "__main__":
    main(sys.argv[1:])
