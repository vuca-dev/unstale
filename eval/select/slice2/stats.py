"""Per-arm extraction stats from a side store's extraction files: records, records per document, grounded quotes,
label fill rates. Usage: python3 stats.py <store-dir>..."""
import glob, json, os, sys

for store in sys.argv[1:]:
    docs = recs = grounded = 0
    fill = {k: 0 for k in ("terms", "replaces", "requires", "prerequisites", "conditions")}
    nterms = 0
    for t in ("next", "prisma", "nestjs"):
        for f in glob.glob(os.path.join(store, "extractions", t, "*.json")):
            L = json.load(open(f))
            docs += 1
            for r in L:
                recs += 1
                grounded += r["grounded"]
                nterms += len(r["terms"])
                for k in fill:
                    # conditions also carry the pipeline's audience notes; count only model-written ones
                    v = [c for c in r[k] if not str(c).startswith("Audience:")] if k == "conditions" else r[k]
                    fill[k] += bool(v)
    print(json.dumps({"store": os.path.basename(store), "documents": docs, "records": recs,
                      "records_per_doc": round(recs / docs, 2), "grounded": round(grounded / recs, 4),
                      "terms_per_record": round(nterms / recs, 2),
                      **{"has_" + k: round(v / recs, 4) for k, v in fill.items()}}))
