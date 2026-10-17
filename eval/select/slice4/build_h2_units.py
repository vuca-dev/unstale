"""Classifier units on held-out set 2 (PREREG.md "Confirm H on H2"): slice 3b's gpt-6-luna H2 records, each with the
breaking flag of the adjudicated group the scorer's precision matching credits it to. Stdlib only.

    python3 build_h2_units.py [RUN_INCOMING] [OUT]
"""
import importlib.util, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("score", os.path.join(HERE, "..", "holdout", "score.py"))
sc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sc)
H2 = os.path.join(HERE, "..", "holdout-majors", "extraction")
RUN = os.path.join(HERE, "..", "out", "slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout2", "incoming.json")
OUT = os.path.join(HERE, "..", "out", "slice4", "h2-units.json")
OBLIG = {"removal", "deprecation"}


def records_by_note(records, manifest):
    """predictions_by_note's list branch, keeping the records: {note_file: [record, ...]} in the same order."""
    by = {f: [] for f in manifest}
    by_tv = {}
    for f, n in manifest.items():
        for t in {n["technology"], n.get("name") or n["technology"]}:
            by_tv.setdefault((sc.tech_key(t), n["version"]), [])
            if f not in by_tv[(sc.tech_key(t), n["version"])]:
                by_tv[(sc.tech_key(t), n["version"])].append(f)
    missing = 0
    for r in records:
        f = sc.note_for(by_tv, manifest, r.get("technology"), r.get("version"), sc.record_kind(r))
        if f is None:
            missing += 1
            continue
        by[f].append(r)
    return by, missing


def main(run=RUN, out=OUT):
    notes = os.path.join(H2, "notes.json")
    manifest = sc.load_manifest(notes)
    labels = sc.rj(os.path.join(H2, "labels", "adjudicated.json"))
    texts = sc.note_texts(notes, manifest)
    by, missing = records_by_note(sc.rj(run), manifest)
    units, counts = [], {"records": 0, "no_note": missing, "no_group": 0, "unsure_group": 0, "kept": 0}
    for f, n in manifest.items():
        gs = sc.note_groups(labels.get(f, []))
        recs = by[f]
        counts["records"] += len(recs)
        _, prec = sc.match_note([r.get("quote") or "" for r in recs], gs)
        sec = sc.Sections(texts.get(f))
        for i, r in enumerate(recs):
            if i not in prec:
                counts["no_group"] += 1
                continue
            g = gs[prec[i]]
            if g["unsure"]:
                counts["unsure_group"] += 1
                continue
            types = sorted({it.get("change_type") for it in g["items"] if it.get("change_type")})
            units.append({
                "id": "h2:%s:%d" % (f, i),
                "note": f,
                "name": n.get("name") or n["technology"],
                "section": "%s#%d" % (f, sec.of_quote(g["anchors"][0] if g["anchors"] else "")),
                "group": g["group"],
                "breaking": g["breaking"],
                "obligation": bool(OBLIG & set(types)),
                "change_types": types,
                "incoming": r,
            })
    counts["kept"] = len(units)
    counts["breaking"] = sum(u["breaking"] for u in units)
    counts["obligation"] = sum(u["obligation"] for u in units)
    counts["sections"] = len({u["section"] for u in units})
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump({"run": os.path.relpath(run, HERE), "counts": counts, "units": units}, fh, indent=1)
    print(json.dumps(counts))


if __name__ == "__main__":
    main(*sys.argv[1:3])
