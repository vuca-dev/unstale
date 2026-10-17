"""Scorers for the per-stage labelled sets in eval/sets (see README.md).

    python3 score.py extraction CATALOG_DIR             extraction recall on extraction-recall.json
    python3 score.py benefit LABELS.json                 benefit labels vs benefit/reference.json; LABELS = {id: [benefits]}
                                                         or a catalog dir (its records' `benefit`)
    python3 score.py breaking LABELS.json                breaking labels vs the 241 agreed judgements;
                                                         LABELS = {rid: true|false}

No model calls.
"""
import difflib
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TECHS = ("next", "prisma", "nestjs")


def load_catalog(cat):
    out = {}
    for t in TECHS:
        p = os.path.join(cat, "v1", "tech", "%s.json" % t)
        if not os.path.exists(p):
            continue
        for s in json.load(open(p))["shards"]:
            path = s["path"] if s["path"].startswith("v1/") else "v1/" + s["path"]
            with gzip.open(os.path.join(cat, path), "rt") as fh:
                for line in fh:
                    r = json.loads(line)
                    if r.get("status") == "active":
                        out[r["id"]] = r
    return out


def norm(q):
    q = re.sub(r"\(?#\d+\)?|[`*_\[\]]", " ", q.lower())
    return re.sub(r"\s+", " ", q).strip()


def same_quote(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return False
    return a in b or b in a or difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= 0.8


def extraction(cat):
    items = json.load(open(os.path.join(HERE, "extraction-recall.json")))["items"]
    recs = load_catalog(cat)
    by_tech = {}
    for r in recs.values():
        by_tech.setdefault(r["technology"], []).append(r)
    tech_of = {"next16": "next", "prisma7": "prisma", "nest12": "nestjs"}
    rows = []
    for it in items:
        tech = tech_of[it["event"].rsplit("-", 1)[1]]
        hit = [r["id"] for r in by_tech.get(tech, []) if any(same_quote(s["quote"], e.get("quote") or "") for s in it["sources"] for e in r["evidence"])]
        rows.append(dict(it, hit=bool(hit), hit_records=hit[:5]))
    def pct(xs):
        return "%d/%d (%.0f%%)" % (sum(x["hit"] for x in xs), len(xs), 100 * sum(x["hit"] for x in xs) / max(1, len(xs)))
    for sp in ("DEV", "HELD-OUT", "ALL"):
        xs = [x for x in rows if sp == "ALL" or x["split"] == sp]
        f = [x for x in xs if x["in_fetched_sources"]]
        print("%-8s all %s | in fetched sources %s | required, fetched %s" % (sp, pct(xs), pct(f), pct([x for x in f if x["required"]])))
    for x in rows:
        if not x["hit"]:
            print("  miss: %s %s %s (%s)" % (x["event"], x["key"], "fetched" if x["in_fetched_sources"] else "not fetched", x["sources"][0]["quote"][:80]))


BENEFITS = ("security", "correctness", "performance", "cost", "maintainability")


def benefit(path):
    ref = {x["id"]: set(x["reference"]) for x in json.load(open(os.path.join(HERE, "benefit", "reference.json")))["items"]}
    if os.path.isdir(path):
        lab = {i: set(r.get("benefit") or ["none"]) for i, r in load_catalog(path).items() if i in ref}
    else:
        lab = {i: set(v) for i, v in json.load(open(path)).items()}
    ids = [i for i in ref if i in lab]
    def some(s):
        return bool(s - {"none", "other"})
    exact = sum(lab[i] - {"other"} == ref[i] or (not some(lab[i]) and not some(ref[i])) for i in ids)
    bn = sum(some(lab[i]) == some(ref[i]) for i in ids)
    print("records %d of %d | identical set %d (%.1f%%) | benefit-vs-none %d (%.1f%%)" % (len(ids), len(ref), exact, 100 * exact / max(1, len(ids)), bn, 100 * bn / max(1, len(ids))))
    for b in BENEFITS:
        tp = sum(b in lab[i] and b in ref[i] for i in ids)
        fp = sum(b in lab[i] and b not in ref[i] for i in ids)
        fn = sum(b not in lab[i] and b in ref[i] for i in ids)
        if tp + fp + fn:
            print("  %-15s ref %3d  precision %s  recall %s" % (b, tp + fn, "%.2f" % (tp / (tp + fp)) if tp + fp else "-", "%.2f" % (tp / (tp + fn)) if tp + fn else "-"))


def breaking(path):
    brk = os.path.expanduser("~/ati-slice2/results/datamodel/breaking")

    def judge(arm):
        out = {}
        for f in sorted(os.listdir(os.path.join(brk, arm))):
            run = json.load(open(os.path.join(brk, arm, f)))
            for n, rid in enumerate(run["unit"]["rids"], 1):
                v = run["answer"].get("r%d" % n)
                if isinstance(v, dict) and isinstance(v.get("breaking"), bool):
                    out[rid] = v["breaking"]
        return out
    items = json.load(open(os.path.join(brk, "items.json")))
    pipe, ref = judge("pipeline"), judge("reference")
    agreed = {i["rid"]: pipe[i["rid"]] for i in items if pipe.get(i["rid"]) == ref.get(i["rid"])}
    lab = json.load(open(path))
    ids = [r for r in agreed if r in lab]
    ok = sum(bool(lab[r]) == agreed[r] for r in ids)
    print("reference %d (%d breaking) | labelled %d | agree %d (%.1f%%) | false breaking %d | missed breaking %d" % (
        len(agreed), sum(agreed.values()), len(ids), ok, 100 * ok / max(1, len(ids)),
        sum(bool(lab[r]) and not agreed[r] for r in ids), sum(agreed[r] and not lab[r] for r in ids)))


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("extraction", "benefit", "breaking"):
        sys.exit(__doc__)
    {"extraction": extraction, "benefit": benefit, "breaking": breaking}[sys.argv[1]](sys.argv[2])
