"""The ordering variants of RESULTS.md ported into the Python replay queue (additive; nothing else changes).

Same queue as eval/rarity-sample/rarity_queue.py with `fallback` weights (the edge at sample_n = 0): same window,
funnel, matching against the event repository and term weights. Then each variant's upgrade order, with the CLI's
`requires` rule (a record whose `requires` literals are all absent from the repository) and its siblings rule
(records sharing a release and a term follow each other inside one sort group). Writes rank_queue.json per event
(never queue.json) and scores the first 16 with the replay's keys and match maps.

    python3 rank_queue.py --catalog DIR --work DIR [--split DEV|HELD-OUT|ALL] [--compare CLI_SCORES.json] [event ...]
"""
import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "rarity-sample"))
import rarity_queue as rq  # noqa: E402
import cli_queue  # noqa: E402

rr, f, replay = rq.rr, rq.f, rq.replay
VARIANTS = ("B", "A0", "A1", "A2", "A3", "A4")


def group_key(v, r):
    t1 = r["tier"] == 0                      # the harness's tier 0 is the CLI's tier 1
    if v == "B":
        return (r["req_miss"], r["tier"], 0)
    if v == "A0":
        return (0, r["tier"], 0)
    if v in ("A1", "A4"):
        return (0, r["tier"], r["req_miss"])
    cls = 0 if not t1 or r["ev_hit"] else (3 if v == "A2" and r["req_miss"] else (1 if r["matched"] else 2))
    return (0, r["tier"], cls)


def order(v, rows):
    key = lambda r: (group_key(v, r), -r["max_w"] if v == "A4" else 0, -r["score"], r["rid"])  # noqa: E731
    srt = sorted(rows, key=key)
    terms = lambda r: {rq.clean(t) for t in r.get("uses") or []} - {None}  # noqa: E731
    placed, out = [False] * len(srt), []
    for i, a in enumerate(srt):
        if placed[i]:
            continue
        placed[i] = True
        out.append(a)
        ta = terms(a)
        for j in range(i + 1, len(srt)):
            b = srt[j]
            if placed[j] or group_key(v, b) != group_key(v, a):
                continue
            if a["release"] == b["release"] and ta & terms(b):
                placed[j] = True
                out.append(b)
    return [r["id"] for r in out]


def queue(ev, catalog):
    """rarity_queue.queue (fallback weights), keeping per-record evidence for the variants."""
    e = replay.info(ev)
    root = os.path.join(replay.snapshot(e), e.get("subdir", ""))
    tech, pkg = e["tech"], e["package"]
    recs = f.relabelled(f.records(tech, extra=replay.CONDS[replay.COND]), "v2")
    win = [r for r in recs if rq.package_of(r) == pkg and rq.vtuple(e["old"]) < rq.vtuple(r["release"]) <= rq.vtuple(e["new"])]
    review = [r for r in win if not (r.get("change_type") in f.NO_DECISION and not r.get("breaking"))]
    ref_text, all_text, paths = rq.repo_text(root, tech)
    names = {p.rsplit("/", 1)[-1] for p in paths} | set(paths)
    tokens = set(re.findall(r"[\w$]+", all_text))
    refs = f.TECH[tech]["refs"]
    applied = [r for r in review if any(len(x) >= 6 and (f._hit(x, all_text, tokens, refs) or x in names) for x in (r.get("introduces") or []))]
    left = [r for r in review if r not in applied]
    seen, uniq = set(), []
    for r in sorted(left, key=lambda r: r["date"]):
        if r["key"].lower() not in seen:
            seen.add(r["key"].lower())
            uniq.append(r)
    h = f._hits(uniq, ref_text, refs)
    w = rq.weights("fallback", catalog, tech)
    ref_tokens = set(re.findall(r"[\w$]+", ref_text))
    rows = []
    for r in uniq:
        matched = sorted(l for l in set(f._lits(r)) if l in h)
        req = [x for x in (rq.clean(y) for y in r.get("requires") or []) if x]
        req_hit = [x for x in req if f._hit(x, ref_text, ref_tokens, refs)]
        repl_hit = [x for x in f._lits(r, ("replaces",)) if x in h]
        rows.append(dict(id=rq._id(r), rid=r["rid"], release=r["release"], uses=r.get("uses") or [], matched=matched,
                         tier=0 if r.get("breaking") else replay.TIER.get(r.get("change_type"), 3),
                         score=round(sum(w(l) for l in matched), 4), max_w=round(max([w(l) for l in matched] or [0]), 4),
                         req_miss=int(bool(req) and not req_hit), ev_hit=bool(req_hit or repl_hit)))
    orders = {v: order(v, rows) for v in VARIANTS}
    os.makedirs(e["cdir"], exist_ok=True)
    json.dump(dict(event=ev, records=rows, orders=orders), open(os.path.join(e["cdir"], "rank_queue.json"), "w"), indent=1)
    return rows, orders


def score(ev, orders, rows):
    d = os.path.join(replay.R, ev)
    k = json.load(open(os.path.join(d, "key.json")))["items"]
    m = json.load(open(os.path.join(d, "match.json")))
    maps = [r["map"] for r in m["runs"]]
    both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
    req = rr.required_labels(ev)
    rid = {r["id"]: r["rid"] for r in rows}
    out = {}
    for v, o in orders.items():
        first = set(o[:16])
        out[v] = dict(required=sum(1 for i in k if req.get(i["id"]) is True and both[i["id"]] & first),
                      all=sum(1 for i in k if both[i["id"]] & first), first16=[rid[x] for x in o[:16]])
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--split", default="DEV", choices=("DEV", "HELD-OUT", "ALL"))
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--compare", nargs="*", default=[], help="cli_queue.py score files (one per variant) to compare first 16 with")
    ap.add_argument("--out")
    ap.add_argument("events", nargs="*")
    a = ap.parse_args()
    work, catalog = os.path.abspath(a.work), os.path.abspath(a.catalog)
    rr.install(catalog, work, "orig")
    evs = cli_queue.events()
    names = a.events or [e for e, x in evs.items() if a.split == "ALL" or x["split"] == a.split]
    vs = a.variants.split(",")
    cli = {json.load(open(p))["variant"]: json.load(open(p))["events"] for p in a.compare}
    res, tot = {}, {}
    for ev in names:
        rr.WINDOW[evs[ev]["tech"]] = (replay.EVENTS[ev]["old"], replay.EVENTS[ev]["new"])
        rows, orders = queue(ev, catalog)
        res[ev] = score(ev, {v: orders[v] for v in vs}, rows)
        for v in vs:
            t = tot.setdefault(v, {}).setdefault(evs[ev]["split"], dict(required=0, all=0, overlap=0, n=0))
            t["required"] += res[ev][v]["required"]
            t["all"] += res[ev][v]["all"]
            if v in cli and ev in cli[v]:
                ov = len(set(res[ev][v]["first16"]) & set(cli[v][ev]["first16"]))
                res[ev][v]["overlap_with_cli"] = ov
                t["overlap"] += ov
                t["n"] += min(16, len(res[ev][v]["first16"]))
        print(ev, evs[ev]["split"], {v: (res[ev][v]["required"], res[ev][v]["all"], res[ev][v].get("overlap_with_cli")) for v in vs}, flush=True)
    print(json.dumps(tot, indent=1))
    if a.out:
        json.dump(dict(totals=tot, events=res), open(a.out, "w"), indent=1)
