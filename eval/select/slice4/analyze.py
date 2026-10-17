"""Slice 4 analysis: fit thresholds on dev per candidate, map held-out answers to the scorer's schema, score, compare
with Jev (J1), Jev repeatability, and cost per technology-year. No model calls.

  python3 eval/select/slice4/analyze.py [--fit-only]

Candidates are run directories under out/slice4/runs: <cand>-dev and <cand>-heldout[-tag].
"""
import argparse
import contextlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out", "slice4")
RUNS = os.path.join(OUT, "runs")
HOLD = os.path.join(HERE, "..", "holdout")
sys.path.insert(0, HOLD)
import score  # noqa: E402

BENEFITS = ("security", "correctness", "performance", "cost", "maintainability")
GRID = [round(0.05 * i, 2) for i in range(1, 20)]
R_MEAN, R_MAX = 114.6, 1092  # cost.mts, .store/central, 16 October 2026

# name -> (dev run, held-out run)
CANDS = {
    "Jev (J1)": ("jev-dev", "jev-heldout-run1"),
    "Jev (J2)": ("jev-dev", "jev-heldout-run2"),
    "Clef Flash": ("clef-dev", "clef-heldout"),
    "gpt-oss-20b": ("vercel_openai_gpt-oss-20b-dev", "vercel_openai_gpt-oss-20b-heldout"),
    "gpt-oss-120b": ("vercel_openai_gpt-oss-120b-dev", "vercel_openai_gpt-oss-120b-heldout"),
    "qwen3.8-flash": ("vercel_alibaba_qwen3.8-flash-dev", "vercel_alibaba_qwen3.8-flash-heldout"),
    "deepseek-v4-flash": ("vercel_deepseek_deepseek-v4-flash-dev", "vercel_deepseek_deepseek-v4-flash-heldout"),
    "Luna (codex)": ("codex-dev", "codex-heldout"),
    "Encoder (ModernBERT)": ("encoder-dev", "encoder-heldout"),
}
BATCH_RE = "batch_"


def rj(p):
    return json.load(open(p))


def p_yes(c, q):
    return c["answers"][q]["probabilities"]["yes"]


def fbeta(tp, fp, fn, beta=2.0):
    if tp == 0:
        return 0.0
    p, r = tp / (tp + fp), tp / (tp + fn)
    return (1 + beta ** 2) * p * r / (beta ** 2 * p + r)


def pick(score_of):
    """Grid value with the best score; ties to the value nearest 0.5."""
    best = max(score_of(t) for t in GRID)
    return min((t for t in GRID if abs(score_of(t) - best) < 1e-12), key=lambda t: abs(t - 0.5))


def fit(dev_run):
    ans = rj(os.path.join(RUNS, dev_run, "answers.json"))
    ref = rj(os.path.join(OUT, "encoder", "dev-ref.json"))
    bref = {x["id"]: set(x["reference"]) for x in rj(os.path.join(HERE, "..", "..", "sets", "benefit", "reference.json"))["items"]}
    # Breaking: 241 items; a missing answer counts as the opposite of the reference.
    brk = ref["breaking"]

    def brk_score(t):
        tp = fp = fn = 0
        for rid, truth in brk.items():
            c = ans.get("breaking:" + rid)
            pred = (p_yes(c, "breaking") >= t) if c else (not truth)
            tp += truth and pred
            fp += (not truth) and pred
            fn += truth and not pred
        return fbeta(tp, fp, fn)

    # Benefit-vs-none: item p = max over its sources and the five benefits (union of sources, as states.aggregate).
    items = {}
    missing = set()
    for uid, item in ref["benefitItemOf"].items():
        c = ans.get(uid)
        if not c:
            missing.add(item)
            continue
        items[item] = max(items.get(item, 0.0), max(p_yes(c, "benefit_" + b) for b in BENEFITS))

    def ben_score(t):
        tp = fp = fn = 0
        for item, r in bref.items():
            truth = bool(r - {"none"})
            pred = (items[item] >= t) if item in items and item not in missing else (not truth)
            tp += truth and pred
            fp += (not truth) and pred
            fn += truth and not pred
        return fbeta(tp, fp, fn)

    bt, nt = pick(brk_score), pick(ben_score)

    def recall_at(kind, t):
        if kind == "breaking":
            pos = [rid for rid, v in brk.items() if v]
            return sum(1 for rid in pos if ans.get("breaking:" + rid) and p_yes(ans["breaking:" + rid], "breaking") >= t) / len(pos)
        pos = [i for i, r in bref.items() if r - {"none"}]
        return sum(1 for i in pos if i in items and i not in missing and items[i] >= t) / len(pos)

    return {"BREAKING_P": bt, "BENEFIT_P": nt, "dev_F2_breaking": brk_score(bt), "dev_F2_benefit": ben_score(nt),
            "dev_breaking_recall": recall_at("breaking", bt), "dev_benefit_recall": recall_at("benefit", nt),
            "dev_breaking_recall_05": recall_at("breaking", 0.5), "dev_benefit_recall_05": recall_at("benefit", 0.5),
            "dev_answered": sum(1 for v in ans.values() if v) / max(1, len(ans))}


def to_pred(ans, bt, nt):
    out = {}
    for uid, c in ans.items():
        if not c:
            continue
        rid = uid.split(":", 1)[1]
        a = c["answers"]
        ben = [b for b in BENEFITS if a["benefit_" + b]["probabilities"]["yes"] >= nt]
        out[rid] = {"breaking": a["breaking"]["probabilities"]["yes"] >= bt, "benefit": ben or ["none"],
                    "change_type": a["change_type"]["choice"], "actionable": a["surface"]["choice"] != "runtime_internal"}
    return out


def metrics(pred, labels):
    rows = score.classify_vectors(pred, labels)
    m = {}
    for k, name in (("breaking", "breaking"), ("benefit_any", "benefit"), ("actionable", "actionable")):
        x = score.prf(rows, k)
        m[name + "_recall"], m[name + "_precision"], m[name + "_pos"], m[name + "_tp"] = x["recall"], x["precision"], x["pos"], x["tp"]
    m["change_type_acc"] = sum(r["change_type"] for r in rows.values()) / len(rows)
    obl = [r for r in rows.values() if r["ct_ref"] in score.OBLIGATION]
    m["obligation_recall"] = sum(r["ct_pred"] in score.OBLIGATION for r in obl) / max(1, len(obl))
    m["obligation_n"] = len(obl)
    m["benefit_exact"] = sum(r["benefit_exact"] for r in rows.values()) / len(rows)
    return m


def compare(a_path, b_path, labels_path):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = score.compare(argparse.Namespace(a=a_path, b=b_path, labels=labels_path, kind="classify", notes=score.NOTES, records=score.RECORDS))
    return res, buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit-only", action="store_true")
    a = ap.parse_args()
    # adjudicated.json also holds an "overrides" list that score.py cannot read; this copy keeps the 233 records only.
    labels_path = os.path.join(OUT, "adjudicated-records.json")
    cands = dict(CANDS)
    for d in sorted(os.listdir(RUNS)):
        if d.startswith(BATCH_RE) and d.endswith("-heldout"):
            model = d[len(BATCH_RE):-len("-heldout")]
            cands["b=10 " + model.split("_", 1)[1]] = (BATCH_RE + model + "-dev", d)
    report = {"fits": {}, "heldout": {}, "heldout_05": {}, "compare": {}, "cost": {}}
    for name, (dv, hv) in cands.items():
        if not os.path.exists(os.path.join(RUNS, dv, "answers.json")):
            continue
        f = fit(dv)
        report["fits"][name] = f
        print("%-24s fit BREAKING_P %.2f BENEFIT_P %.2f | dev F2 %.3f / %.3f | dev recall breaking %.3f benefit %.3f (at 0.5: %.3f / %.3f) | dev answered %.3f" % (
            name, f["BREAKING_P"], f["BENEFIT_P"], f["dev_F2_breaking"], f["dev_F2_benefit"], f["dev_breaking_recall"], f["dev_benefit_recall"], f["dev_breaking_recall_05"], f["dev_benefit_recall_05"], f["dev_answered"]))
    if a.fit_only:
        json.dump(report["fits"], open(os.path.join(OUT, "fits.json"), "w"), indent=1)
        return
    labels = rj(labels_path)
    for name, (dv, hv) in cands.items():
        hp = os.path.join(RUNS, hv, "answers.json")
        if not os.path.exists(hp) or name not in report["fits"]:
            continue
        ans = rj(hp)
        f = report["fits"][name]
        for tag, bt, nt in (("fit", f["BREAKING_P"], f["BENEFIT_P"]), ("05", 0.5, 0.5)):
            pred = to_pred(ans, bt, nt)
            path = os.path.join(RUNS, hv, "pred-%s.json" % tag)
            json.dump(pred, open(path, "w"), indent=1)
            m = metrics(pred, labels)
            m["answered"] = len(pred) / len(labels)
            report["heldout" if tag == "fit" else "heldout_05"][name] = m
        meta_p = os.path.join(RUNS, hv, "meta.json")
        if os.path.exists(meta_p):
            meta = rj(meta_p)
            per = meta["dollars"] / meta["units"]
            report["cost"][name] = {"per_record": per, "run_dollars": meta["dollars"], "calls_per_record": meta["calls_per_record"],
                                    "input_per_record": meta["input_per_record"], "output_per_record": meta["output_per_record"],
                                    "reasoning_per_record": meta["reasoning_per_record"], "units_per_s": meta["units_per_s"],
                                    "tech_year_mean": per * R_MEAN, "tech_year_max": per * R_MAX,
                                    "fleet_10k": per * R_MEAN * 1e4, "fleet_50k": per * R_MEAN * 5e4, "fleet_200k": per * R_MEAN * 2e5}
    base = os.path.join(RUNS, cands["Jev (J1)"][1], "pred-fit.json")
    base05 = os.path.join(RUNS, cands["Jev (J1)"][1], "pred-05.json")
    base2 = os.path.join(RUNS, cands["Jev (J2)"][1], "pred-fit.json")
    texts = []
    for name, (dv, hv) in cands.items():
        p = os.path.join(RUNS, hv, "pred-fit.json")
        if name == "Jev (J1)" or not os.path.exists(p):
            continue
        res, txt = compare(base, p, labels_path)
        res05, _ = compare(base05, os.path.join(RUNS, hv, "pred-05.json"), labels_path)
        res2, _ = compare(base2, p, labels_path)
        report["compare"][name] = {"vs_J1": res, "vs_J1_at_05": res05, "vs_J2": res2}
        texts.append("== %s vs Jev J1 (fitted thresholds)\n%s" % (name, txt))
    open(os.path.join(OUT, "compare.txt"), "w").write("\n".join(texts))
    # Decision rule.
    j = report["heldout"]["Jev (J1)"]
    floors = (("breaking recall", "breaking_recall"), ("benefit-vs-none recall", "benefit_recall"), ("actionable recall (yes)", "actionable_recall"))
    verdict = {}
    for name in report["compare"]:
        m = report["heldout"][name]
        why = []
        for cname, key in floors:
            if m[key] < j[key] - 0.05:
                why.append("%s %.1f vs Jev %.1f (> 5 pts below)" % (key, 100 * m[key], 100 * j[key]))
            ci = report["compare"][name]["vs_J1"][cname]["ci"]
            if ci[1] < 0:
                why.append("%s significantly worse (CI %+.1f..%+.1f)" % (key, 100 * ci[0], 100 * ci[1]))
        better = [cname for cname, key in floors if report["compare"][name]["vs_J1"][cname]["ci"][0] > 0]
        verdict[name] = {"pass": not why, "why": why, "significantly_better_than_J1": better}
    report["verdict"] = verdict
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1, default=str)
    pc = lambda v: "-" if v != v else "%.1f" % (100 * v)
    print("\nHELD-OUT at fitted thresholds (floor: breaking R, benefit R, actionable R | secondary: breaking P, benefit P, change_type acc, obligation R)")
    for name, m in report["heldout"].items():
        c = report["cost"].get(name, {})
        v = verdict.get(name, {"pass": "baseline"})
        print("%-24s bR %5s bnR %5s aR %5s | bP %5s bnP %5s ct %5s obl %5s (n %d) | answered %5s | $/rec %s  $/tech-yr %s | %s %s" % (
            name, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["breaking_precision"]), pc(m["benefit_precision"]),
            pc(m["change_type_acc"]), pc(m["obligation_recall"]), m["obligation_n"], pc(m["answered"]),
            "%.6f" % c["per_record"] if c else "-", "%.4f" % c["tech_year_mean"] if c else "-", "PASS" if v["pass"] is True else ("FAIL" if v["pass"] is False else v["pass"]), "; ".join(v.get("why", []))))
    print("\nHELD-OUT at 0.5")
    for name, m in report["heldout_05"].items():
        print("%-24s bR %5s bnR %5s aR %5s | bP %5s bnP %5s ct %5s" % (name, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"])))


if __name__ == "__main__":
    main()
