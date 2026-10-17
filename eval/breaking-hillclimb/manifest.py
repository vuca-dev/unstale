"""Dev manifest: for each replay event, the catalog records in the event's window (the ids the final replay's match
ran against) and the incoming extraction keys folded into each. Read-only over the store and the final replay work dir.

    python3 manifest.py <store> <final replay work dir> <out.json>
"""
import json
import os
import re
import sys

EVENTS = [("workout-next16", "next"), ("invoicerr-prisma7", "prisma"), ("invoicerr-nest12", "nestjs")]


def slug(tech, key):
    return "%s-%s" % (tech, re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")[:48])


def main(store, final, out):
    res = {}
    for ev, tech in EVENTS:
        st = json.load(open(os.path.join(store, "central", "records", "%s.json" % tech)))
        by = {}
        for r in sorted(st["records"].values(), key=lambda r: r["id"]):
            if r["status"] != "active":
                continue
            s = slug(tech, r["id"].split(":", 1)[1])
            if s in by:                       # run_replay.records: the second id that slugs alike gets -2
                s += "-2"
            by[s] = r
        ids = json.load(open(os.path.join(final, "replay", ev, "match.json")))["catalog"]
        missing = [i for i in ids if i not in by]
        assert not missing, missing
        res[ev] = dict(tech=tech, records={i: dict(rid=by[i]["id"], breaking=by[i]["breaking"], sources=by[i]["sources"])
                                           for i in ids})
        print(ev, len(ids), "records", sum(len(by[i]["sources"]) for i in ids), "sources")
    json.dump(res, open(out, "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
