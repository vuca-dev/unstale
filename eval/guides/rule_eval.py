"""Simulate the cross-source rule on the audited pairs (pairs.json + verdicts.json): per guide item in ingest (key)
order, the best candidate at p >= T that the breaking and advisory guards allow, and that holds no evidence from the
same guide snapshot yet (a record that already took an item of this guide is not a candidate: matching's snapshot
exclusion). Counts merges by my verdict of the chosen pair, and items with a SAME pair that did not merge.

    python3 rule_eval.py pairs.json verdicts.json
"""
import json
import re
import sys
from collections import defaultdict

P = json.load(open(sys.argv[1]))
V = json.load(open(sys.argv[2]))
for p in P:
    p["v"] = V[str(p["n"])]


def keyorder(k):
    return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", k)]


def run(T, techs):
    by = defaultdict(list)
    for p in P:
        if p["technology"] in techs:
            by[p["incoming"]["key"]].append(p)
    out = dict(merges=0, S=0, D=0, U=0, missed_same=0, false=[])
    taken = set()
    for k in sorted(by, key=keyorder):
        ps = by[k]
        ok = [p for p in ps if p["p"] >= T and not p["guards"]["breaking"] and not p["guards"]["advisory"] and p["candidate"]["id"] not in taken]
        if ok:
            b = max(ok, key=lambda p: p["p"])
            taken.add(b["candidate"]["id"])
            out["merges"] += 1
            out[b["v"]] += 1
            if b["v"] != "S":
                out["false"].append((b["n"], b["v"]))
        elif any(p["v"] == "S" for p in ps):
            out["missed_same"] += 1
    return out


if __name__ == "__main__":
    for T in (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98):
        print(T, "| tune prisma+nestjs", run(T, {"prisma", "nestjs"}), "| held-out next", run(T, {"next"}), "| all", {k: v for k, v in run(T, {"next", "prisma", "nestjs"}).items() if k != "false"})
