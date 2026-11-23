"""Edge encoder, stage 5 (PREREG.md, "Stage 5, fixed before any stage 5 label exists"): sample the units once, by
sha256 of `edge-s5:<record id>`, from data.jsonl. No model calls.

  A  250 records of validation technologies, at most 5 per technology.
  B  150 records of validation-technology releases x.0.0 (x >= 1), at most 5 per technology, disjoint from A.
  C  100 records of training technologies outside the capped training sample (train.py), dated 2026-10-01 or later.

Writes <out>/units.json (id -> stratum, state, Jev's cached answers) and <out>/packet.json (id -> state only, in
sampled order shuffled by sha256, for the blind labelers).

  python3 eval/edge-encoder/s5-units.py --data <data.jsonl> --out <dir>
"""
import argparse
import hashlib
import json
import os
import random
import re


def h(s):
    return int(hashlib.sha256(s.encode()).hexdigest(), 16)


MAJOR = re.compile(r"v?([1-9][0-9]*)\.0\.0")


def take(pool, n, per_tech):
    out, count = [], {}
    for r in sorted(pool, key=lambda r: h("edge-s5:" + r["id"])):
        if len(out) == n:
            break
        if per_tech is not None and count.get(r["tech"], 0) >= per_tech:
            continue
        count[r["tech"]] = count.get(r["tech"], 0) + 1
        out.append(r)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cap", type=int, default=200)  # train.py's per-technology cap
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    by_tech = {}
    for line in open(a.data):
        if line.strip():
            x = json.loads(line)
            by_tech.setdefault(x["tech"], []).append(x)
    techs = sorted(by_tech)
    val = {t for t in techs if h("edge-val:" + t) % 10 == 0}
    # train.py at frac 1.0 trains on every non-validation technology, capped with the same rng and list order.
    in_sample = set()
    for t in techs:
        if t in val:
            continue
        rs = by_tech[t]
        in_sample.update(r["id"] for r in (rs if len(rs) <= a.cap else random.Random(h("edge-cap:" + t)).sample(rs, a.cap)))
    val_rows = [r for t in sorted(val) for r in by_tech[t]]
    A = take(val_rows, 250, 5)
    a_ids = {r["id"] for r in A}
    B = take([r for r in val_rows if r["id"] not in a_ids and MAJOR.fullmatch(r["state"]["release"])], 150, 5)
    c_pool = [r for t in techs if t not in val for r in by_tech[t] if r["id"] not in in_sample and r["date"] >= "2026-10-01"]
    C = take(c_pool, 100, None)
    units = {}
    for name, rs in (("A", A), ("B", B), ("C", C)):
        for r in rs:
            units[r["id"]] = {"stratum": name, "tech": r["tech"], "date": r["date"], "jev": r["jev"], "state": r["state"], "answers": r["answers"]}
    json.dump(units, open(os.path.join(a.out, "units.json"), "w"), indent=1)
    order = sorted(units, key=lambda i: h("edge-s5-order:" + i))
    json.dump({i: units[i]["state"] for i in order}, open(os.path.join(a.out, "packet.json"), "w"), indent=1)
    print(json.dumps({"technologies": len(techs), "validation": len(val), "training_sample": len(in_sample), "A": len(A), "B": len(B), "C": len(C),
                      "B_pool": sum(1 for r in val_rows if r["id"] not in a_ids and MAJOR.fullmatch(r["state"]["release"])), "C_pool": len(c_pool),
                      "techs": {k: len({r["tech"] for r in v}) for k, v in (("A", A), ("B", B), ("C", C))}}))


if __name__ == "__main__":
    main()
