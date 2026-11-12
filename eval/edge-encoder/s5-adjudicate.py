"""Edge encoder, stage 5: merge the two blind labelers into s5-adjudicated.json. A field both labelers agree on is
kept; every field they disagree on (breaking, benefit set, change_type, actionable) takes the adjudicator's value,
written from the record state alone (s5-label.mts show) before any Jev or encoder answer was read. No model calls.

  python3 eval/edge-encoder/s5-adjudicate.py --dir <s5 dir> --decisions <decisions.json>

decisions.json: {id: {"fields": {field: value}, "reason": "..."}}.
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FIELDS = ("breaking", "benefit", "change_type", "actionable")


def ben(b):
    s = sorted(set(b) - {"none"})
    return s or ["none"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--decisions", required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "s5-adjudicated.json"))
    a = ap.parse_args()
    j1 = json.load(open(os.path.join(a.dir, "labels-j1.json")))
    j2 = json.load(open(os.path.join(a.dir, "labels-j2.json")))
    dec = json.load(open(a.decisions))
    units = json.load(open(os.path.join(a.dir, "units.json")))
    labels, adj, missing = {}, {}, []
    for i in sorted(units):
        x, y = dict(j1[i], benefit=ben(j1[i]["benefit"])), dict(j2[i], benefit=ben(j2[i]["benefit"]))
        diff = [f for f in FIELDS if x[f] != y[f]]
        d = dec.get(i, {"fields": {}})
        lab = {f: x[f] for f in FIELDS}
        for f in diff:
            if f not in d["fields"]:
                missing.append((i, f))
                continue
            lab[f] = ben(d["fields"][f]) if f == "benefit" else d["fields"][f]
        extra = set(d["fields"]) - set(diff)
        assert not extra, (i, extra)
        labels[i] = lab
        if diff:
            adj[i] = {"j1": {f: x[f] for f in diff}, "j2": {f: y[f] for f in diff}, "decided": {f: lab[f] for f in diff}, "reason": d["reason"]}
    assert not missing, missing
    assert set(dec) <= set(adj), set(dec) - set(adj)
    json.dump({"labels": labels, "adjudications": adj, "agreement": {f: sum(1 for i in units if not (i in adj and f in adj[i]["decided"])) / len(units) for f in FIELDS}},
              open(a.out, "w"), indent=1)
    print("labels %d, adjudicated units %d, fields %d" % (len(labels), len(adj), sum(len(v["decided"]) for v in adj.values())))


if __name__ == "__main__":
    main()
