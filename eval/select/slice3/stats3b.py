"""Slice 3b statistics on held-out set 2 (holdout-majors; PREREG.md "Slice 3b"): floor metrics, precision and slices per
run, and paired comparisons B - A through score.py's own `compare` (section bootstrap, Addendum). Stdlib only.

    python3 stats3b.py table RUN_DIR... [--json OUT]
    python3 stats3b.py compare A_RUN B_RUN [--json OUT]
"""
import argparse, contextlib, importlib.util, io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score", os.path.join(HERE, "..", "holdout", "score.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)
H2 = os.path.join(HERE, "..", "holdout-majors", "extraction")
LABELS = os.path.join(H2, "labels", "adjudicated.json")
NOTES = os.path.join(H2, "notes.json")


def inc(run):
    return run if run.endswith(".json") else os.path.join(run, "incoming.json")


def metrics(run):
    manifest = sc.load_manifest(NOTES)
    groups, recs = sc.extraction_rows(sc.predictions_by_note(inc(run), manifest), sc.rj(LABELS), manifest)
    f = lambda xs: sum(x["hit"] for x in xs) / len(xs) if xs else float("nan")
    sel = lambda gs: {"required_sure": f([x for x in gs if x["required_sure"]]), "required": f([x for x in gs if x["required"]]),
                      "breaking": f([x for x in gs if x["breaking"]]), "recall": f(gs), "recall_sure": f([x for x in gs if not x["unsure"]])}
    out = dict(sel(groups), precision=f(recs), records=len(recs), records_per_doc=len(recs) / len(manifest))
    out["by_kind"] = {k: dict(sel([x for x in groups if x["kind"] == k]), precision=f([x for x in recs if x["kind"] == k]),
                              records=sum(1 for x in recs if x["kind"] == k)) for k in ("guide", "major_notes")}
    out["by_tech"] = {t: dict(sel([x for x in groups if x["tech"] == t]), precision=f([x for x in recs if x["tech"] == t]),
                              records=sum(1 for x in recs if x["tech"] == t)) for t in sorted({x["tech"] for x in groups})}
    out["by_doc"] = {n: dict(sel([x for x in groups if x["note"] == n]), records=sum(1 for x in recs if x["note"] == n)) for n in sorted(manifest)}
    return out


def compare(a, b):
    ns = argparse.Namespace(a=inc(a), b=inc(b), labels=LABELS, notes=NOTES, kind="extraction", unit="auto")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = sc.compare(ns)
    print(buf.getvalue(), end="")
    res = {k: dict(v, ci=list(v["ci"])) for k, v in r.items()}
    res["precision"] = dict(r.precision, ci=list(r.precision["ci"]))
    res["unit"] = r.unit
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("table", "compare"))
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--json")
    a = ap.parse_args()
    if a.cmd == "table":
        res = {}
        for r in a.runs:
            m = metrics(r)
            res[os.path.basename(r.rstrip("/"))] = m
            print("%-58s req-sure %5.1f  req %5.1f  breaking %5.1f  recall %5.1f  precision %5.1f  rec/doc %5.1f | guide req %5.1f  notes req %5.1f" % (
                os.path.basename(r.rstrip("/")), *(100 * m[k] for k in ("required_sure", "required", "breaking", "recall", "precision")), m["records_per_doc"],
                100 * m["by_kind"]["guide"]["required_sure"], 100 * m["by_kind"]["major_notes"]["required_sure"]))
    else:
        res = compare(*a.runs)
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
