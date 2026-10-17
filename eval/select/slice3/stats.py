"""Slice 3 statistics on the held-out extraction set (PREREG.md): the floor metrics and precision for each run, and
paired comparisons B - A with score.py's own `paired` (exact McNemar on groups, 2,000-resample bootstrap of whole notes,
seed 20261016). Standard library only; no model calls.

    python3 stats.py table RUN_DIR... [--notes SUBSET.json]
    python3 stats.py compare A_RUN B_RUN [--notes SUBSET.json]
    python3 stats.py subset RUN_DIR OUT.json      # manifest of the notes RUN_DIR's meta.json lists as complete
"""
import argparse, importlib.util, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score", os.path.join(HERE, "..", "holdout", "score.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)
LABELS = os.path.join(HERE, "..", "holdout", "extraction", "labels", "adjudicated.json")


def rows(run, manifest):
    pred = sc.predictions_by_note(os.path.join(run, "incoming.json"), manifest)
    return sc.extraction_rows(pred, sc.rj(LABELS), manifest)


def metrics(groups, recs):
    sure = [x for x in groups if not x["unsure"]]
    brk = [x for x in groups if x["breaking"]]
    f = lambda xs: sum(x["hit"] for x in xs) / len(xs) if xs else float("nan")
    return {"pooled_excl_unsure": f(sure), "macro_excl_unsure": sc.macro(sure)[0], "breaking": f(brk),
            "precision": f(recs), "records": len(recs), "n_sure": len(sure), "n_breaking": len(brk),
            "by_tech": {t: f([x for x in sure if x["tech"] == t]) for t in sorted({x["tech"] for x in groups})},
            "by_eco": {e: f([x for x in sure if x["eco"] == e]) for e in sorted({x["eco"] for x in groups})},
            "prec_by_eco": {e: f([x for x in recs if x["eco"] == e]) for e in sorted({x["eco"] for x in groups})}}


def compare(a, b, manifest):
    ia, ra = rows(a, manifest)
    ib, rb = rows(b, manifest)
    rng = random.Random(sc.SEED)
    ids = list(range(len(ia)))
    clusters = {i: ia[i]["note"] for i in ids}
    side = {"a": ia, "b": ib}
    rate = lambda s, k: sum(side[k][i]["hit"] for i in s) / len(s) if s else float("nan")

    def macro(s, k):
        c, h = {}, {}
        for i in s:
            n = clusters[i]
            c[n] = c.get(n, 0) + 1
            h[n] = h.get(n, 0) + side[k][i]["hit"]
        # Each note weighs 1 per draw (a note drawn twice counts twice): per-note rate times draws.
        size = {}
        for i in ids:
            if not ia[i]["unsure"]:
                size[clusters[i]] = size.get(clusters[i], 0) + 1
        w = {n: c[n] / size[n] for n in c}
        return sum(w[n] * h[n] / c[n] for n in c) / sum(w.values()) if c else float("nan")

    out = {}
    sure = [i for i in ids if not ia[i]["unsure"]]
    brk = [i for i in ids if ia[i]["breaking"]]
    for name, sub, m in (("pooled_excl_unsure", sure, rate), ("macro_excl_unsure", sure, macro), ("breaking", brk, rate)):
        out[name] = sc.paired(name, sub, {i: ia[i]["hit"] for i in sub}, {i: ib[i]["hit"] for i in sub}, m, rng, clusters)
        out[name]["discordant"] = (out[name]["b"] + out[name]["c"]) / max(1, len(sub))
    notes = sorted(manifest)
    recs = {"a": ra, "b": rb}

    def prec(ns, k):
        idx = {}
        for n in ns:
            idx[n] = idx.get(n, 0) + 1
        hit = sum(r["hit"] * idx.get(r["note"], 0) for r in recs[k])
        tot = sum(idx.get(r["note"], 0) for r in recs[k])
        return hit / tot if tot else float("nan")
    base = prec(notes, "b") - prec(notes, "a")
    diffs = sorted(d for d in (prec(s, "b") - prec(s, "a") for s in ([rng.choice(notes) for _ in notes] for _ in range(sc.BOOT))) if d == d)
    lo, hi = diffs[int(0.025 * len(diffs))], diffs[int(0.975 * len(diffs)) - 1]
    print("  %-30s A %6.1f%%  B %6.1f%%  diff %+6.1f pts  95%% CI [%+.1f, %+.1f]" % ("precision", 100 * prec(notes, "a"), 100 * prec(notes, "b"), 100 * base, 100 * lo, 100 * hi))
    out["precision"] = {"diff": base, "ci": (lo, hi)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--notes", default=sc.NOTES)
    ap.add_argument("--json")
    a = ap.parse_args()
    if a.cmd == "subset":
        run, out = a.runs
        keep = set(json.load(open(os.path.join(run, "meta.json")))["docs_complete"])
        m = sc.rj(sc.NOTES)
        m["notes"] = [n for n in m["notes"] if n["note_file"] in keep]
        json.dump(m, open(out, "w"), indent=1)
        print("%d notes" % len(m["notes"]))
        return
    manifest = sc.load_manifest(a.notes)
    if a.cmd == "table":
        res = {}
        for r in a.runs:
            m = metrics(*rows(r, manifest))
            res[os.path.basename(r.rstrip("/"))] = m
            print("%-55s pooled %5.1f  macro %5.1f  breaking %5.1f  precision %5.1f  records %4d (%.2f/note)  %s" % (
                os.path.basename(r.rstrip("/")), 100 * m["pooled_excl_unsure"], 100 * m["macro_excl_unsure"], 100 * m["breaking"],
                100 * m["precision"], m["records"], m["records"] / len(manifest), {k: round(100 * v, 1) for k, v in m["by_tech"].items()}))
        if a.json:
            json.dump(res, open(a.json, "w"), indent=1)
    elif a.cmd == "compare":
        res = compare(a.runs[0], a.runs[1], manifest)
        if a.json:
            json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
