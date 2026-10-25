"""Score frozen compact.mts arms at live thresholds; stdlib, no model calls. H1/H2 are reused screening sets."""
import argparse
import collections
import importlib.util
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score", os.path.join(HERE, "../holdout/score.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)
BENEFITS = ("security", "correctness", "performance", "cost", "maintainability")


def read(path):
    with open(path) as f:
        return json.load(f)


def prediction(c):
    if not c:
        return None
    a = c["answers"]
    benefits = [b for b in BENEFITS if a["benefit_" + b]["probabilities"]["yes"] >= .5]
    return {"breaking": a["breaking"]["probabilities"]["yes"] >= .5,
            "benefit": benefits or ["none"], "change_type": a["change_type"]["choice"],
            "actionable": a["surface"]["choice"] != "runtime_internal"}


def vectors(answers, refs, split):
    preds = {i: prediction(answers.get(i)) for i in refs}
    rows = {}
    if split == "h1":
        raw = sc.classify_vectors(preds, refs)
        for i, r in raw.items():
            # A metric is numerator/denominator. Binary recall and precision are kept separate.
            row = {"change_type_accuracy": (int(r["change_type"]), 1), "benefit_exact": (int(r["benefit_exact"]), 1)}
            for name, key in [("breaking", "breaking"), ("benefit", "benefit_any"), ("actionable", "actionable")]:
                x = r[key]
                row[name + "_recall"] = (int(x["ref"] and x["pred"]), int(x["ref"]))
                if name != "actionable":
                    row[name + "_precision"] = (int(x["ref"] and x["pred"]), int(x["pred"]))
            row["obligation_recall"] = (int(r["ct_ref"] in sc.OBLIGATION and r["ct_pred"] in sc.OBLIGATION), int(r["ct_ref"] in sc.OBLIGATION))
            for b in BENEFITS:
                x = r["benefit:" + b]
                row[b + "_recall"] = (int(x["ref"] and x["pred"]), int(x["ref"]))
            rows[i] = row
    else:
        for i, ref in refs.items():
            p = preds[i]
            hit = bool(p and p["breaking"])
            # Missing predictions are wrong, never silently removed from the denominator.
            positive = hit if p else not ref["breaking"]
            rows[i] = {
                "breaking_recall": (int(ref["breaking"] and hit), int(ref["breaking"])),
                "breaking_precision": (int(ref["breaking"] and hit), int(positive)),
                "obligation_recall": (int(ref["obligation"] and bool(p and p["change_type"] in sc.OBLIGATION)), int(ref["obligation"])),
                "change_type_accuracy": (int(bool(p and p["change_type"] in ref["change_types"])), 1),
            }
    return rows


def rates(rows, ids):
    result = {}
    for k in next(iter(rows.values())):
        n = sum(rows[i][k][0] for i in ids)
        d = sum(rows[i][k][1] for i in ids)
        result[k] = n / d if d else None
    return result


def compare(a, b, clusters):
    ids = sorted(a)
    av, bv = rates(a, ids), rates(b, ids)
    by_cluster = collections.defaultdict(list)
    for i in ids:
        by_cluster[clusters[i]].append(i)
    keys = sorted(by_cluster)
    rng = random.Random(20261025)
    # Sum numerators/denominators by cluster once; resampling does not repeatedly scan all record fields.
    agg = {}
    for side, rows in [("a", a), ("b", b)]:
        agg[side] = {k: {m: (sum(rows[i][m][0] for i in by_cluster[k]), sum(rows[i][m][1] for i in by_cluster[k])) for m in av} for k in keys}
    diffs = {m: [] for m in av}
    for _ in range(2000):
        draw = [rng.choice(keys) for _ in keys]
        for m in av:
            sums = {s: (sum(agg[s][k][m][0] for k in draw), sum(agg[s][k][m][1] for k in draw)) for s in agg}
            if sums["a"][1] and sums["b"][1]:
                diffs[m].append(sums["b"][0] / sums["b"][1] - sums["a"][0] / sums["a"][1])
    out = {}
    for m, ds in diffs.items():
        ds.sort()
        out[m] = {"diff": None if av[m] is None or bv[m] is None else bv[m] - av[m],
                  "ci": [ds[int(len(ds) * .025)], ds[min(len(ds) - 1, int(len(ds) * .975))]] if ds else None}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    plan = read(os.path.join(args.out, "plan.json"))
    base = os.path.join(args.data_root, "eval/select")
    h1 = read(os.path.join(base, "holdout/classify/records.json"))["records"]
    h1ref = sc.classify_ref(os.path.join(base, "holdout/classify/labels/adjudicated.json"))
    h2 = read(os.path.join(base, "out/slice4/h2-units.json"))["units"]
    refs = {"h1": {"h1:" + r["id"]: h1ref[r["id"]] for r in h1}, "h2": {r["id"]: r for r in h2}}
    clusters = {"h1": {"h1:" + r["id"]: r["source_key"].split("#")[0] for r in h1}, "h2": {r["id"]: r["section"] for r in h2}}
    usage = read(os.path.join(args.out, "usage.json"))
    report = {"plan_sha256": __import__("hashlib").sha256(open(os.path.join(args.out, "plan.json"), "rb").read()).hexdigest(), "screen_only": True, "arms": {}, "comparisons": {}}
    all_vectors = {}
    for arm in plan["arms"]:
        answers = read(os.path.join(args.out, arm + ".json"))
        if set(answers) != set(refs["h1"]) | set(refs["h2"]):
            raise ValueError(f"{arm}: incomplete experiment; do not score a partial run")
        all_vectors[arm] = {s: vectors(answers, r, s) for s, r in refs.items()}
        calls = [u for u in usage if u["arm"] == arm]
        tokens = sum(u.get("input_tokens", 0) for u in calls)
        report["arms"][arm] = {"input_tokens": tokens, "dollars": sum(u.get("dollars", 0) for u in calls),
            "models": sorted({u["model"] for u in calls if "model" in u}),
            "failures": sum(v is None for v in answers.values()),
            "metrics": {s: rates(all_vectors[arm][s], sorted(r)) for s, r in refs.items()}}
    for arm in plan["arms"]:
        if arm == "baseline":
            continue
        report["comparisons"][arm] = {s: compare(all_vectors["baseline"][s], all_vectors[arm][s], clusters[s]) for s in refs}
        drops = [f"{s}:{m}" for s, ms in report["comparisons"][arm].items() for m, d in ms.items() if d["diff"] is not None and d["diff"] < -1e-12]
        report["arms"][arm]["measured_drops"] = drops
        report["arms"][arm]["screen_pass"] = not drops and not report["arms"][arm]["failures"]
        report["arms"][arm]["input_saving"] = 1 - report["arms"][arm]["input_tokens"] / report["arms"]["baseline"]["input_tokens"]
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    for arm, r in report["arms"].items():
        print(arm, json.dumps(r))


if __name__ == "__main__":
    main()
