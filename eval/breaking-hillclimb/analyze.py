"""Scores every (variant, classifier) label set: held-out agreement with the reference judges' agreed labels, P0-vs-P1
flips, P0 reproduction of the catalog labels, and (via devrun.py) the dev metric. Writes <hc>/analysis.json.

    python3 analyze.py <hc dir> [--no-dev]
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BRK = os.path.expanduser("~/ati-slice2/results/datamodel/breaking")
VARIANTS = ("P0", "P1", "P2", "P3", "P4")
CLASSIFIERS = ("jev", "luna", "codex")


def judge(arm):
    out = {}
    d = os.path.join(BRK, arm)
    for f in sorted(os.listdir(d)):
        run = json.load(open(os.path.join(d, f)))
        for n, rid in enumerate(run["unit"]["rids"], 1):
            v = run["answer"].get("r%d" % n)
            if isinstance(v, dict) and isinstance(v.get("breaking"), bool):
                out[rid] = v["breaking"]
    return out


def load(hc, set_, v, c):
    p = os.path.join(hc, "labels", "%s_%s_%s.json" % (set_, v, c))
    return {k: x["choice"] == "yes" for k, x in json.load(open(p)).items()} if os.path.exists(p) else None


def main(hc, dev=True):
    items = json.load(open(os.path.join(BRK, "items.json")))
    pipe, ref = judge("pipeline"), judge("reference")
    agreed = {i["rid"]: pipe[i["rid"]] for i in items if pipe[i["rid"]] == ref[i["rid"]]}
    split = {i["rid"]: (pipe[i["rid"]], ref[i["rid"]]) for i in items if pipe[i["rid"]] != ref[i["rid"]]}
    kind = {i["rid"]: i["kind"] for i in items}
    res = dict(reference=dict(n=len(agreed), breaking=sum(agreed.values()), split=len(split)), heldout={}, flips={}, dev={}, repro={})
    for v in VARIANTS:
        for c in CLASSIFIERS:
            lab = load(hc, "heldout", v, c)
            if lab is None:
                continue
            ag = [r for r in agreed if r in lab]
            row = dict(n=len(ag), missing=len(agreed) - len(ag),
                       agree=sum(lab[r] == agreed[r] for r in ag),
                       false_breaking=sum(lab[r] and not agreed[r] for r in ag),
                       missed_breaking=sum(agreed[r] and not lab[r] for r in ag),
                       yes=sum(lab.values()), split_yes=sum(lab.get(r, False) for r in split))
            row["pct"] = round(100 * row["agree"] / max(1, row["n"]), 1)
            for k in ("guide", "notes"):
                g = [r for r in ag if kind[r] == k]
                row["pct_" + k] = round(100 * sum(lab[r] == agreed[r] for r in g) / max(1, len(g)), 1)
            res["heldout"]["%s/%s" % (v, c)] = row
    for c in CLASSIFIERS:
        for s in ("heldout", "dev"):
            a, b = load(hc, s, "P0", c), load(hc, s, "P1", c)
            if a and b:
                common = [k for k in a if k in b]
                n = sum(a[k] != b[k] for k in common)
                res["flips"]["%s/%s" % (s, c)] = dict(n=len(common), flips=n, pct=round(100 * n / len(common), 1),
                                                      to_yes=sum(b[k] and not a[k] for k in common), to_no=sum(a[k] and not b[k] for k in common))
    man = json.load(open(os.path.join(hc, "dev_manifest.json")))
    cached = load(hc, "dev", "P0", "cached")
    for c in CLASSIFIERS:
        lab = load(hc, "dev", "P0", c)
        if not lab:
            continue
        common = [k for k in cached if k in lab]
        recs = [r for e in man.values() for r in e["records"].values() if all(s in lab for s in r["sources"])]
        res["repro"][c] = dict(extractions=len(common), same=sum(lab[k] == cached[k] for k in common),
                               to_yes=sum(lab[k] and not cached[k] for k in common), to_no=sum(cached[k] and not lab[k] for k in common),
                               records=len(recs), records_same=sum(any(lab[s] for s in r["sources"]) == r["breaking"] for r in recs))
    if dev:
        for v in VARIANTS:
            for c in CLASSIFIERS + ("cached",):
                p = os.path.join(hc, "labels", "dev_%s_%s.json" % (v, c))
                if not os.path.exists(p):
                    continue
                name = "%s-%s" % (v, c)
                d = os.path.join(hc, "runs", name, "dev.json")
                lab = json.load(open(p))
                need = len(man) and (sum(len(e["records"]) for e in man.values()) if v in ("P3", "P4") else sum(len(r["sources"]) for e in man.values() for r in e["records"].values()))
                if len(lab) < need:
                    print("skip dev", name, "labelled", len(lab), "of", need)
                    continue
                if not os.path.exists(d) or json.load(open(d)).get("labels_mtime") != os.path.getmtime(p):
                    subprocess.run([sys.executable, os.path.join(HERE, "devrun.py"), hc, name, p] + (["--record-level"] if v in ("P3", "P4") else []), check=True)
                    x = json.load(open(d))
                    x["labels_mtime"] = os.path.getmtime(p)
                    json.dump(x, open(d, "w"), indent=1)
                x = json.load(open(d))
                res["dev"][name] = dict(total=x["total"], events={ev: dict(first16=e["first16"], queue=e["queue"], tiers=e["tiers"], first16_ids=e["first16_ids"])
                                                                  for ev, e in x["events"].items()}, record_flips=x["record_flips"])
    json.dump(res, open(os.path.join(hc, "analysis.json"), "w"), indent=1)
    print("reference", res["reference"])
    for k, r in res["heldout"].items():
        print("held-out %-10s agree %5.1f%% (%d/%d) false-breaking %3d missed %3d yes %3d split-yes %d" % (k, r["pct"], r["agree"], r["n"], r["false_breaking"], r["missed_breaking"], r["yes"], r["split_yes"]))
    for k, r in res["flips"].items():
        print("P0vP1 %-14s %s" % (k, r))
    for k, r in res["repro"].items():
        print("repro %-6s %s" % (k, r))
    for k, r in res["dev"].items():
        print("dev %-12s first16 %2d  %s  tier0 %s" % (k, r["total"]["first16"], {e: x["first16"] for e, x in r["events"].items()}, list(r["total"]["tier0"].values())))


if __name__ == "__main__":
    main(sys.argv[1], "--no-dev" not in sys.argv)
