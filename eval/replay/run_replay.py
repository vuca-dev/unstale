"""Run ~/ati-slice0/harness/replay.py against an unstale catalog, without editing the harness.

The harness is imported read-only; every path it writes to is redirected into a scratch work dir, and its catalog
reader (fw_spike.records / relabelled, and the url lookup) is replaced by one that reads the published unstale
catalog (v1/tech/<t>.json -> gz JSON-lines shards). Answer keys are the harness's own replay/<event>/key.json, copied,
never regenerated.

    python3 run_replay.py --catalog DIR --work DIR setup
    python3 run_replay.py --catalog DIR --work DIR queue|match|review|score [event ...] [--arms tier,all]
    python3 run_replay.py --catalog DIR --work DIR split [--labels key_labels.json]

replay.py does not apply changes or run checks; neither does this wrapper.
"""
import argparse
import builtins
import gzip
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True          # never write __pycache__ into ~/ati-slice0/harness
HARNESS = os.path.expanduser("~/ati-slice0/harness")
SRC = os.path.expanduser("~/ati-slice0")
sys.path.insert(0, HARNESS)

import e2e_queue  # noqa: E402
import e2e_run  # noqa: E402
import fw_spike as f  # noqa: E402
import replay  # noqa: E402
import synth_spike  # noqa: E402

EVENTS = ("workout-next16", "invoicerr-prisma7", "invoicerr-nest12")
# Expanded set (events/EVENTS.md): pins in events/events.json, reviewed answer keys in events/keys/<event>.json.
HERE = os.path.dirname(os.path.abspath(__file__))
EV_DIR = os.path.join(HERE, "events")
NEW_EVENTS = json.load(open(os.path.join(EV_DIR, "events.json"))) if os.path.exists(os.path.join(EV_DIR, "events.json")) else {}
ORIG_SPLIT = {ev: "DEV" for ev in EVENTS}          # the original three were already used for tuning
for _ev, _x in NEW_EVENTS.items():
    replay.EVENTS[_ev] = dict(slot=_x["slot"], tech=_x["tech"], package=_x["package"], old=_x["old"], new=_x["new"],
                              upgrade=_x["upgrade"], **({"subdir": _x["subdir"]} if _x.get("subdir") else {}))
SETS = {"orig": EVENTS, "new": tuple(NEW_EVENTS), "all": EVENTS + tuple(NEW_EVENTS)}
NOT_COVERED = {"krayin-laravel12": "not covered (no Laravel in the catalog)"}
WINDOW = {}                              # tech -> (old, new) of the event being run


def vt(v):
    return e2e_queue.vtuple(v)


def load_catalog(cat, tech):
    ix = json.load(open(os.path.join(cat, "v1", "tech", "%s.json" % tech)))
    out = []
    for s in ix["shards"]:
        with gzip.open(os.path.join(cat, s["path"]), "rt") as fh:
            out += [json.loads(l) for l in fh if l.strip()]
    # Merged and retracted stubs carry no record (catalogs with twin merges, 16 October 2026).
    return [r for r in out if r.get("status", "active") == "active"]


def to_row(r, window):
    """One harness record per catalog record. The release is the earliest one inside the event's window, so the
    harness's window test (old < release <= new) sees the release the window contains."""
    rels = sorted({(x["version"], x.get("date") or "") for x in r.get("releases") or []}, key=lambda x: vt(x[0]))
    inwin = [x for x in rels if window and vt(window[0]) < vt(x[0]) <= vt(window[1])]
    ver, date = (inwin or rels[-1:] or [("0.0.0", "")])[0]
    ev = r.get("evidence") or []
    return dict(key=r["id"].split(":", 1)[-1], change_type=r.get("change_type"), surface=r.get("surface"),
                breaking=bool(r.get("breaking")), summary=r.get("summary") or "", introduces=r.get("introduces") or [],
                uses=[t[0] if isinstance(t, list) else t for t in r.get("terms") or []], replaces=r.get("replaces") or [],
                prerequisites=r.get("prerequisites") or [], evidence=ev, benefit=r.get("benefit"), requires=r.get("requires"),
                tech=r["technology"], release=ver, date=date, rid=r["id"], url=ev[0].get("url") if ev else None)


def _slug(tech, key):
    return "%s-%s" % (tech, re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")[:48])


def install(catalog, work, cond):
    """Redirect every harness write path into `work` and point the catalog reader at `catalog`."""
    R = os.path.join(work, "replay")
    FW = os.path.join(work, "fw")
    replay.R, replay.FULL, replay.COND = R, os.path.join(R, "full"), cond
    f.DIR = FW
    f.OUT, f.SECTIONS, f.CASES = os.path.join(FW, "extracted"), os.path.join(FW, "sections.json"), os.path.join(FW, "cases")
    f.SECTIONS_EXTRA, f.PKG_DIR, f.CORPUS = os.path.join(FW, "sections_extra.json"), os.path.join(FW, "pkg"), os.path.join(FW, "corpus")
    e2e_run.E2E = os.path.join(work, "e2e")
    e2e_run.OUT = os.path.join(work, "e2e", "runs")
    e2e_queue.E2E = os.path.join(work, "e2e")
    synth_spike.DIR = os.path.join(work, "synth")
    synth_spike.OUT, synth_spike.SECTIONS = os.path.join(work, "synth", "extracted"), os.path.join(work, "synth", "sections.json")

    cache = {}

    def records(tech=None, extra=()):
        if tech not in cache:
            cache[tech] = load_catalog(catalog, tech) if os.path.exists(os.path.join(catalog, "v1", "tech", "%s.json" % tech)) else []
        rows, seen = [], set()
        for r in sorted(cache[tech], key=lambda r: r["id"]):
            row = to_row(r, WINDOW.get(tech))
            if _slug(tech, row["key"]) in seen:          # two ids that slug alike (next:agents-md / next:agents.md)
                row["key"] += "-2"
            seen.add(_slug(tech, row["key"]))
            rows.append(row)
        return rows

    def urls():
        return {r["rid"]: r["url"] for t in cache for r in (to_row(x, None) for x in cache[t]) if r["url"]}

    f.records = records
    f.relabelled = lambda recs, version: [dict(r) for r in recs]   # terms are the catalog's own labels
    replay._urls = urls
    e2e_run._urls = urls

    # Guard: any open() for writing from a harness module must land inside the work dir.
    real_open = builtins.open
    root = os.path.realpath(work)

    def guarded(file, mode="r", *a, **k):
        if any(c in mode for c in "wax+") and not os.path.realpath(str(file)).startswith(root + os.sep):
            raise PermissionError("harness tried to write outside the work dir: %s" % file)
        return real_open(file, mode, *a, **k)
    for m in (replay, f, e2e_run, e2e_queue, synth_spike):
        m.open = guarded
    for p in (replay.R, replay.FULL, f.DIR, f.OUT, f.SECTIONS, f.CASES, f.SECTIONS_EXTRA, f.PKG_DIR, f.CORPUS,
              e2e_run.E2E, e2e_run.OUT, e2e_queue.E2E, synth_spike.DIR):
        assert os.path.realpath(p).startswith(root + os.sep), p


def setup(work):
    """Copy the inputs the harness reads (APFS clones): answer keys, full clones, the usage corpus."""
    R = os.path.join(work, "replay")
    os.makedirs(os.path.join(R, "full"), exist_ok=True)
    os.makedirs(os.path.join(work, "fw"), exist_ok=True)
    for ev in EVENTS:
        os.makedirs(os.path.join(R, ev), exist_ok=True)
        dst = os.path.join(R, ev, "key.json")
        if not os.path.exists(dst):
            subprocess.run(["cp", "-c", os.path.join(SRC, "replay", ev, "key.json"), dst], check=True)
        slot = replay.EVENTS[ev]["slot"]
        if not os.path.exists(os.path.join(R, "full", slot)):
            subprocess.run(["cp", "-cR", os.path.join(SRC, "replay", "full", slot), os.path.join(R, "full", slot)], check=True)
    for ev, x in NEW_EVENTS.items():
        os.makedirs(os.path.join(R, ev), exist_ok=True)
        dst, src = os.path.join(R, "full", x["slot"]), os.path.join(EVENTS_SRC, x["slot"])
        if not os.path.exists(dst) and os.path.exists(src):
            subprocess.run(["cp", "-cR", src, dst], check=True)
        k = os.path.join(EV_DIR, "keys", ev + ".json")
        if os.path.exists(k) and not os.path.exists(os.path.join(R, ev, "key.json")):
            subprocess.run(["cp", "-c", k, os.path.join(R, ev, "key.json")], check=True)
    if not os.path.exists(os.path.join(work, "fw", "corpus")):
        subprocess.run(["cp", "-cR", os.path.expanduser("~/Library/Caches/ati-slice0/fw/corpus"), os.path.join(work, "fw", "corpus")], check=True)
    print("setup done:", work)


def run_stage(stage, evs, arms):
    if stage == "key":
        if any(ev not in NEW_EVENTS for ev in evs):
            sys.exit("refusing: answer keys are reused from ~/ati-slice0/replay/<event>/key.json, never regenerated")
        for ev in evs:                                   # draft only; the reviewed key lives in events/keys/<event>.json
            replay.key(ev)
        return
    if stage == "score":
        replay.score(evs)
        return
    for ev in evs:
        e = replay.EVENTS[ev]
        WINDOW[e["tech"]] = (e["old"], e["new"])
        if stage == "queue":
            replay.queue(ev)
        elif stage == "match":
            replay.match(ev)
        elif stage == "review":
            replay.review(ev, arms)


def split(work, cond, labels_path, evs):
    """Coverage and found, separately for key changes the classifier labelled required and optional."""
    R = os.path.join(work, "replay")
    labels = json.load(open(labels_path))["labels"] if labels_path and os.path.exists(labels_path) else {}
    out = {}
    for ev in evs:
        d = os.path.join(R, ev) if cond == "orig" else os.path.join(R, ev, cond)
        k = json.load(open(os.path.join(R, ev, "key.json")))["items"]
        m = json.load(open(os.path.join(d, "match.json")))
        q = json.load(open(os.path.join(d, "queue.json")))
        maps = [r["map"] for r in m["runs"]]
        both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
        inq = set(m["in_queue"])
        lab = {i["id"]: (labels.get(ev, {}).get(i["id"], {}).get("label") or "unlabelled") for i in k}
        row = {}
        for cls in sorted(set(lab.values())):
            ids = [i for i in lab if lab[i] == cls]
            covered = [i for i in ids if both[i]]
            queued = [i for i in ids if both[i] & inq]
            r = dict(key=len(ids), covered=len(covered), queued=len(queued), covered_ids=covered,
                     first16={n: sum(1 for i in queued if both[i] & set(o[:replay.BATCH])) for n, o in q["orders"].items()}, reviews={})
            runs = os.path.join(d, "runs")
            for name in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
                p = os.path.join(runs, name, "review.json")
                if os.path.exists(p):
                    rv = json.load(open(p))
                    v = e2e_run.verdicts(rv["final"], rv["ids"])
                    r["reviews"][name] = sum(1 for i in queued if any(v.get(x) in ("do now", "later") for x in both[i]))
            row[cls] = r
        out[ev] = row
    json.dump(out, open(os.path.join(R, "split_%s.json" % cond), "w"), indent=1)
    print(json.dumps({ev: {c: {x: y for x, y in r.items() if x != "covered_ids"} for c, r in row.items()} for ev, row in out.items()}, indent=1))


def usage(work, cond, evs):
    """Codex usage summed from the harness's own records of each call (its JSON turn.completed events)."""
    R = os.path.join(work, "replay")
    tot = {"match": dict(calls=0), "review": dict(calls=0)}
    for ev in evs:
        d = os.path.join(R, ev) if cond == "orig" else os.path.join(R, ev, cond)
        items = []
        if os.path.exists(os.path.join(d, "match.json")):
            items += [("match", r["usage"]) for r in json.load(open(os.path.join(d, "match.json")))["runs"]]
        runs = os.path.join(d, "runs")
        for name in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
            p = os.path.join(runs, name, "review.json")
            if os.path.exists(p):
                items.append(("review", json.load(open(p))["usage"]))
        for kind, u in items:
            tot[kind]["calls"] += 1
            for x, y in u.items():
                tot[kind][x] = tot[kind].get(x, 0) + y
    print(json.dumps(tot, indent=1))
    return tot


def required_labels(ev):
    """Rule-based required/optional per key change (events/keys/<ev>.json or events/labels_orig.json); not a classifier."""
    p = os.path.join(EV_DIR, "keys", ev + ".json")
    if os.path.exists(p):
        return {i["id"]: i.get("required") for i in json.load(open(p))["items"]}
    p = os.path.join(EV_DIR, "labels_orig.json")
    if os.path.exists(p):
        return {k: v["required"] for k, v in json.load(open(p)).get(ev, {}).items()}
    return {}


def metrics(work, cond, evs, out_path):
    """Deterministic queue metric (no review agent): coverage and first-batch membership per order, split by
    required/optional and by DEV/HELD-OUT."""
    R = os.path.join(work, "replay")
    rows = {}
    for ev in evs:
        d = os.path.join(R, ev) if cond == "orig" else os.path.join(R, ev, cond)
        k = json.load(open(os.path.join(R, ev, "key.json")))["items"]
        m = json.load(open(os.path.join(d, "match.json")))
        q = json.load(open(os.path.join(d, "queue.json")))
        maps = [r["map"] for r in m["runs"]]
        both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
        either = {i["id"]: set(maps[0].get(i["id"], [])) | set(maps[1].get(i["id"], [])) for i in k}
        inq = set(m["in_queue"])
        req = required_labels(ev)
        row = dict(split=NEW_EVENTS.get(ev, {}).get("split") or ORIG_SPLIT.get(ev), tech=replay.EVENTS[ev]["tech"],
                   queue_size=q["counts"]["queue"], tier0=q["counts"]["tiers"].get("0", q["counts"]["tiers"].get(0)), classes={})
        for cls, ids in (("all", [i["id"] for i in k]), ("required", [i["id"] for i in k if req.get(i["id"]) is True]),
                         ("optional", [i["id"] for i in k if req.get(i["id"]) is False])):
            queued = [i for i in ids if both[i] & inq]
            row["classes"][cls] = dict(key=len(ids), covered=sum(1 for i in ids if both[i]), covered_either=sum(1 for i in ids if either[i]),
                                       queued=len(queued),
                                       first16={n: sum(1 for i in queued if both[i] & set(o[:replay.BATCH])) for n, o in q["orders"].items()})
        rows[ev] = row
    json.dump(rows, open(out_path, "w"), indent=1)
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--cond", default="orig", choices=("orig", "notes"))
    ap.add_argument("--arms", default="usage,tier,random,all")
    ap.add_argument("--labels")
    ap.add_argument("--set", default="orig", choices=tuple(SETS), help="default events when none are named")
    ap.add_argument("--events-src", default=os.environ.get("REPLAY_EVENTS_SRC", ""), help="dir holding full clones of the new events")
    ap.add_argument("--out", help="metrics: output JSON path")
    ap.add_argument("stage", choices=("setup", "key", "queue", "match", "review", "score", "split", "usage", "metrics"))
    ap.add_argument("events", nargs="*")
    a = ap.parse_args()
    for ev in a.events:
        if ev in NOT_COVERED:
            sys.exit("%s: %s" % (ev, NOT_COVERED[ev]))
    evs = a.events or list(SETS[a.set])
    EVENTS_SRC = os.path.abspath(os.path.expanduser(a.events_src)) if a.events_src else ""
    work, catalog = os.path.abspath(os.path.expanduser(a.work)), os.path.abspath(os.path.expanduser(a.catalog))
    install(catalog, work, a.cond)
    if a.stage == "setup":
        setup(work)
    elif a.stage == "split":
        split(work, a.cond, a.labels, evs)
    elif a.stage == "usage":
        usage(work, a.cond, evs)
    elif a.stage == "metrics":
        metrics(work, a.cond, evs, a.out or os.path.join(work, "replay", "metrics_%s.json" % a.cond))
    else:
        run_stage(a.stage, evs, tuple(a.arms.split(",")))
        if a.stage in ("queue", "match", "review") and not a.events:
            for ev, why in NOT_COVERED.items():
                print(ev, why)
