"""Classify every active record's `requires` value (published catalog), deterministically:
  self       the record's own release component, or the technology's core package (says nothing)
  introduced the change has the project add it: the value is in `introduces`, or the summary tells the user to
             install / load / switch to / use something (`must|need to|requires? (install|load|switch|use)`, `switch to`)
  condition  the rest: a driver, dialect, adapter or platform the record applies to (the vault's meaning)
A record counts once, by its first matching class over its values (introduced > self > condition).
    python3 requires_audit.py CATALOG_DIR [--list]"""
import gzip, json, os, re, sys
from collections import Counter

cat = sys.argv[1]
CORE = {"next": {"next"}, "prisma": {"prisma", "@prisma/client"}, "nestjs": {"@nestjs/core", "@nestjs/common"}}
ADD = re.compile(r"(must|need to|needs to|requires?|should) (install|load|switch|use)|switch(es)? to|installing", re.I)
rows = []
for t in CORE:
    ix = json.load(open(os.path.join(cat, "v1", "tech", t + ".json")))
    for s in ix["shards"]:
        for l in gzip.open(os.path.join(cat, s["path"]), "rt"):
            r = json.loads(l)
            if r.get("status") != "active" or not r.get("requires"):
                continue
            comps = {re.sub(r"^pkg:npm/", "", x["component"]).replace("%40", "@") for x in r["releases"]}
            intro = {x.lower() for x in r.get("introduces") or []}
            cls = []
            for v in r["requires"]:
                if v.lower() in intro or ADD.search(r["summary"]):
                    cls.append("introduced")
                elif v in comps or v in CORE[t]:
                    cls.append("self")
                else:
                    cls.append("condition")
            c = "introduced" if "introduced" in cls else ("self" if "self" in cls else "condition")
            oblig = r.get("breaking") or r["change_type"] in ("removal", "deprecation")
            rows.append((t, r["id"], c, oblig, r["requires"]))
print("records with requires:", len(rows))
print("all:", dict(Counter(c for *_, c, o, _ in [(x[0], x[1], x[2], x[3], x[4]) for x in rows])))
print("obligations (upgrade review):", dict(Counter(x[2] for x in rows if x[3])))
if "--list" in sys.argv:
    for x in rows:
        print(*x, sep=" | ")
