"""Deterministic replay queue with the term weights the unstale edge would use (no model call).

The harness's queue (~/ati-slice0/harness/replay.py `queue`) weights matched terms by rarity across its own background
corpus. This runs the same queue (same window, funnel, matching against the event repository and orders) with the
weight swapped, so the three weightings can be compared on one catalog:

  harness   the harness's own corpus (as in eval/replay/RESULTS.md)
  fallback  no sample: rarity among the catalog's own terms, ln((N+1)/(df+0.5)), N = the technology's records,
            df = records whose terms or replaces contain the literal (the edge with sample_n = 0)
  sample    the central sample: ln((n+1)/(c+0.5)), n = the index's sample_n, c = the published count of the term
            (the edge with sample_n > 0; a literal with no published count, e.g. only in `replaces`, counts 0)

    python3 rarity_queue.py --catalog DIR --work DIR --weights harness|fallback|sample [event ...]
    python3 rarity_queue.py --catalog DIR --work DIR --weights ... --score [event ...]

Match results are reused: copy a previous run's <work>/replay/<event>/match.json into the work dir (ids are the same
when only the term counts differ). The harness is imported read-only through eval/replay/run_replay.py.
"""
import argparse
import json
import math
import os
import random
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "replay"))
import run_replay as rr  # noqa: E402

f, replay = rr.f, rr.replay
from e2e_queue import package_of, repo_text, vtuple  # noqa: E402
from e2e_run import _id  # noqa: E402


def clean(term):
    lits = f._lits({"uses": [term]})
    return lits[0] if lits else None


def weights(mode, catalog, tech):
    if mode == "harness":
        return None
    recs = [r for r in rr.load_catalog(catalog, tech) if r.get("status") == "active"]
    refs = f.TECH[tech]["refs"]
    if mode == "sample":
        n = json.load(open(os.path.join(catalog, "v1", "tech", "%s.json" % tech)))["sample_n"]
        if not n:
            sys.exit("%s: sample_n is 0 in this catalog" % tech)
        count = {}
        for r in recs:
            for t in r.get("terms") or []:
                l = clean(t[0])
                if l:
                    count[l] = max(count.get(l, 0), t[1])
        return lambda l: math.log((n + 1) / (min(count.get(l, 0), n) + 0.5))
    df = {}
    for r in recs:
        row = {"uses": [t[0] for t in r.get("terms") or []], "replaces": r.get("replaces") or []}
        for l in set(f._lits(row)):
            if l not in refs:
                df[l] = df.get(l, 0) + 1
    N = len(recs)
    return lambda l: math.log((N + 1) / (df.get(l, 0) + 0.5))


def queue(ev, mode, catalog):
    """replay.queue for condition orig, with the weight function swapped (everything else line for line)."""
    e = replay.info(ev)
    snap = replay.snapshot(e)
    root = os.path.join(snap, e.get("subdir", ""))
    tech, pkg = e["tech"], e["package"]
    recs = f.relabelled(f.records(tech, extra=replay.CONDS[replay.COND]), "v2")
    win = [r for r in recs if package_of(r) == pkg and vtuple(e["old"]) < vtuple(r["release"]) <= vtuple(e["new"])]
    review = [r for r in win if not (r.get("change_type") in f.NO_DECISION and not r.get("breaking"))]
    ref_text, all_text, paths = repo_text(root, tech)
    names = {p.rsplit("/", 1)[-1] for p in paths} | set(paths)
    tokens = set(re.findall(r"[\w$]+", all_text))
    assert replay.COND == "orig"
    applied = [r for r in review if any(len(x) >= 6 and (f._hit(x, all_text, tokens, f.TECH[tech]["refs"]) or x in names)
                                        for x in (r.get("introduces") or []))]
    left = [r for r in review if r not in applied]
    seen, uniq = set(), []
    for r in sorted(left, key=lambda r: r["date"]):
        if r["key"].lower() not in seen:
            seen.add(r["key"].lower())
            uniq.append(r)
    h = f._hits(uniq, ref_text, f.TECH[tech]["refs"])
    w = weights(mode, catalog, tech)
    if w is None:
        bg = [f.json.load(f.gzip.open(os.path.join(f.CORPUS, x))) for x in sorted(os.listdir(f.CORPUS)) if x.startswith(tech + "__")]
        bgh = [f._hits(uniq, b["ref_text"], f.TECH[tech]["refs"]) for b in bg]
        w = lambda l: math.log((len(bgh) + 1) / (sum(l in x for x in bgh) + 0.5))  # noqa: E731
    urls = replay._urls()
    out = []
    for r in uniq:
        matched = sorted(l for l in set(f._lits(r)) if l in h)
        out.append(dict(r, id=_id(r), url=urls.get(r["rid"].split("#")[0]), matched=matched,
                        tier=0 if r.get("breaking") else replay.TIER.get(r.get("change_type"), 3),
                        score=round(sum(w(l) for l in matched), 4)))
    random.Random(0).shuffle(out)
    orders = {"usage": [r["id"] for r in sorted(out, key=lambda r: -r["score"])],
              "tier": [r["id"] for r in sorted(out, key=lambda r: (r["tier"], -r["score"]))],
              "random": [r["id"] for r in random.Random(1).sample(out, len(out))]}
    counts = dict(window=len(win), bump_line=len(win) - len(review), applied=len(applied), duplicates=len(left) - len(uniq), queue=len(uniq),
                  matched=sum(1 for r in out if r["matched"]), tiers={t: sum(r["tier"] == t for r in out) for t in range(4)})
    os.makedirs(e["cdir"], exist_ok=True)
    json.dump(dict(event=ev, weights=mode, counts=counts, records=out, orders=orders), open(os.path.join(e["cdir"], "queue.json"), "w"), indent=1)
    print("queue", ev, mode, counts, flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--weights", required=True, choices=("harness", "fallback", "sample"))
    ap.add_argument("--score", action="store_true")
    ap.add_argument("events", nargs="*")
    a = ap.parse_args()
    evs = a.events or list(rr.EVENTS)
    work, catalog = os.path.abspath(a.work), os.path.abspath(a.catalog)
    rr.install(catalog, work, "orig")
    if a.score:
        replay.score(evs)
    else:
        for ev in evs:
            e = replay.EVENTS[ev]
            rr.WINDOW[e["tech"]] = (e["old"], e["new"])
            queue(ev, a.weights, catalog)
