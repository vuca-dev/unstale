"""Gate scorer: tables from gate.py's score JSON, and a comparison against a baseline.

    python3 score.py RESULT.json                      markdown tables (per split x required/optional)
    python3 score.py RESULT.json --baseline BASE.json  the same with deltas against the baseline
    python3 score.py RESULT.json --json OUT.json       also write the summary numbers

Per split (DEV, HELD-OUT, ALL) and class (all, required, optional):
  deterministic   key, covered (both match runs), in the CLI queue, in the CLI's first 16 (event technology only, i.e.
                  the other technologies' targets pinned), and first 16 as invoked (other technologies at their
                  default target, the newest release)
  per review arm  found = key changes whose entry the review proposed (do now or later), summed over events per run;
                  mean [min-max] over the K runs; found_now = "do now" only
  noise           "do now" proposals on entries no key change maps to, per review (mean over all reviews of the arm)
  cost            review input tokens per key change found (sum over the arm's reviews / sum of found)
  variance        sd of the per-run sums; unstable = key changes found in some runs but not all
"""
import argparse
import json
import statistics as st

SPLITS = ("DEV", "HELD-OUT", "ALL")
CLASSES = ("all", "required", "optional")


def summarise(res):
    ev = res["events"]
    K, arms = res["k"], res["arms"]
    out = {}
    for sp in SPLITS:
        es = [e for e in ev if sp == "ALL" or ev[e]["split"] == sp]
        s = out[sp] = {"events": len(es)}
        for cls in CLASSES:
            d = {x: sum(ev[e]["deterministic"][cls][x] for e in es) for x in ("key", "covered", "queued", "first16", "first16_invoked")}
            for arm in arms:
                found, now, tokens, offkey, nrev = [], [], [], [], 0
                ever, always = 0, 0
                for rep in range(1, K + 1):
                    name = "%s__%02d" % (arm, rep)
                    rs = [ev[e]["reviews"][name] for e in es if name in ev[e]["reviews"]]
                    if len(rs) < len(es):
                        continue
                    found.append(sum(r["classes"][cls]["found"] for r in rs))
                    now.append(sum(r["classes"][cls]["found_now"] for r in rs))
                    tokens.append(sum(r["tokens"] for r in rs))
                    offkey.append(sum(len(r["do_now_off_key"]) for r in rs))
                    nrev += len(rs)
                for e in es:
                    sets = [set(ev[e]["reviews"]["%s__%02d" % (arm, rep)]["found_ids"]) for rep in range(1, K + 1)
                            if "%s__%02d" % (arm, rep) in ev[e]["reviews"]]
                    keep = {k for k, v in ev[e]["per_key"].items() if cls == "all" or v["cls"] == cls}
                    if sets:
                        ever += len(set.union(*sets) & keep)
                        always += len(set.intersection(*sets) & keep)
                if not found:
                    continue
                d[arm] = dict(runs=len(found), found=found, found_mean=round(st.mean(found), 2), found_min=min(found), found_max=max(found),
                              found_sd=round(st.pstdev(found), 2), found_now_mean=round(st.mean(now), 2),
                              unstable=ever - always, found_any_run=ever, found_every_run=always,
                              do_now_off_key_per_review=round(sum(offkey) / nrev, 2), do_now_off_key_per_run=offkey,
                              tokens_per_found=round(sum(tokens) / sum(found)) if sum(found) else None,
                              tokens_per_run_mean=round(st.mean(tokens)))
            s[cls] = d
    return out


def fmt_arm(a, b=None, key="found_mean"):
    if not a:
        return "-"
    x = "%.1f [%d-%d]" % (a["found_mean"], a["found_min"], a["found_max"])
    if b:
        x += " (%+.1f)" % (a["found_mean"] - b["found_mean"])
    return x


def table(summ, arms, base=None):
    lines = ["| Split | Class | Key | Covered | In CLI queue | CLI first 16 | First 16 as invoked | " +
             " | ".join("%s: found mean [min-max] | %s: do now (found) | %s: unstable" % (a, a, a) for a in arms) + " |",
             "|" + "---|" * (7 + 3 * len(arms))]
    for sp in SPLITS:
        for cls in CLASSES:
            d = summ[sp][cls]
            b = base[sp][cls] if base else None

            def num(x):
                return "%d" % d[x] + (" (%+d)" % (d[x] - b[x]) if b else "")
            cells = [sp + " (%d)" % summ[sp]["events"], cls, "%d" % d["key"], num("covered"), num("queued"), num("first16"), num("first16_invoked")]
            for a in arms:
                x = d.get(a)
                cells += [fmt_arm(x, b.get(a) if b else None), "%.1f" % x["found_now_mean"] if x else "-", "%d" % x["unstable"] if x else "-"]
            lines.append("| " + " | ".join(cells) + " |")
    lines += ["", "| Split | Arm | Do now outside the key, per review | per run (sum) | Input tokens per key change found | Input tokens per run | Found per run (all) | sd |",
              "|---|---|---|---|---|---|---|---|"]
    for sp in SPLITS:
        for a in arms:
            x = summ[sp]["all"].get(a)
            if not x:
                continue
            lines.append("| %s | %s | %.2f | %s | %s | %s | %s | %.2f |" % (
                sp, a, x["do_now_off_key_per_review"], x["do_now_off_key_per_run"], "{:,}".format(x["tokens_per_found"]) if x["tokens_per_found"] else "-",
                "{:,}".format(x["tokens_per_run_mean"]), x["found"], x["found_sd"]))
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("result")
    ap.add_argument("--baseline")
    ap.add_argument("--json")
    a = ap.parse_args()
    res = json.load(open(a.result))
    summ = summarise(res)
    base = summarise(json.load(open(a.baseline))) if a.baseline else None
    print(table(summ, res["arms"], base))
    if a.json:
        json.dump(summ, open(a.json, "w"), indent=1)
