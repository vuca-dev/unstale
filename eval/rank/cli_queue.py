"""The upgrade-review order as the unstale CLI produces it, on each replay event's snapshot, scored with the
expanded replay's answer keys and Codex match maps (no model call here).

    python3 cli_queue.py --bin PATH --catalog DIR --work DIR --out DIR [--variant NAME] [--mode dump|loop] [event ...]

--work is a run_replay.py work dir that already holds, per event, `snap/` (the repository at P), `key.json`,
`match.json` and `queue.json` (the Python queue, used only to map catalog ids to the match maps' entry ids).

Modes:
  loop  the shipped CLI, unmodified: `init`, `sync`, `review --pass upgrade-review --target ...`, then `decide <id>
        do-now` for every handed-out record and `review --next`, until 16 records of the event's technology are out.
        A do-now mark takes a record out of the open queue without a ledger line, so the rest keep their order.
  dump  an instrumented scratch build that writes its whole upgrade order to $UNSTALE_RANK_DUMP and picks the
        ordering variant from $UNSTALE_RANK_VARIANT (never shipped; used while iterating).

Targets: every npm component of the event's technology that has a catalog release on the new major, at the event's
new version. Records of other technologies in the same queue are skipped: the key covers one technology.
"""
import argparse
import gzip
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "replay"))
import run_replay as rr  # noqa: E402

BATCH = 16
TODAY = "2026-10-15"


def events():
    ev = {e: dict(tech=x["tech"], new=x["new"], split=x["split"]) for e, x in rr.NEW_EVENTS.items()}
    for e in rr.EVENTS:
        x = rr.replay.EVENTS[e]
        ev[e] = dict(tech=x["tech"], new=x["new"], split="DEV")
    return ev


def targets(catalog, tech, new):
    major = new.split(".")[0]
    names = set()
    for r in rr.load_catalog(catalog, tech):
        for rel in r.get("releases") or []:
            m = re.match(r"pkg:npm/(.+)$", rel.get("component", ""))
            if m and rel.get("version", "").split(".")[0] == major:
                names.add(m.group(1).replace("%40", "@"))
    return sorted("%s@%s" % (n, new) for n in names)


def run(binary, repo, env, *args, check=True):
    p = subprocess.run([binary, "-C", repo, *args], env=env, capture_output=True, text=True)
    if check and p.returncode not in (0,):
        raise SystemExit("%s %s: exit %d\n%s%s" % (binary, " ".join(args), p.returncode, p.stdout, p.stderr))
    return p


def skill_ids(repo):
    p = os.path.join(repo, ".unstale", "skills", "upgrade-review", "SKILL.md")
    if not os.path.exists(p):
        return []
    return re.findall(r"^### \[([^\]]+)\] rev", open(p).read(), re.M)


def cli_order(a, ev, x):
    """Catalog ids of the event's technology in the CLI's upgrade-review order (first 16 in loop mode)."""
    d = os.path.join(a.out, ev)
    repo = os.path.join(d, "repo")
    if a.mode == "loop" and os.path.exists(repo):
        subprocess.run(["rm", "-rf", repo], check=True)
    if not os.path.exists(repo):
        os.makedirs(d, exist_ok=True)
        subprocess.run(["cp", "-cR", os.path.join(a.work, "replay", ev, "snap"), repo], check=True)
    env = dict(os.environ, UNSTALE_CACHE_DIR=os.path.join(a.out, "cache"), UNSTALE_TODAY=TODAY)
    env.pop("UNSTALE_CATALOG", None)
    if not os.path.exists(os.path.join(repo, ".unstale", "config.json")):
        run(a.bin, repo, env, "init", "--catalog", a.catalog, "--mode", "local", "--yes")
    run(a.bin, repo, env, "sync")
    tg = [y for t in targets(a.catalog, x["tech"], x["new"]) for y in ("--target", t)]
    if a.mode == "dump":
        dump = os.path.join(d, "dump_%s.json" % a.variant)
        env.update(UNSTALE_RANK_VARIANT=a.variant, UNSTALE_RANK_DUMP=dump)
        run(a.bin, repo, env, "review", "--pass", "upgrade-review", *tg)
        rows = json.load(open(dump))
        return [r["id"] for r in rows if r["tech"] == x["tech"]], rows
    order, step = [], 0
    run(a.bin, repo, env, "review", "--pass", "upgrade-review", *tg)
    while True:
        ids = skill_ids(repo)
        if not ids:
            break
        order += ids
        if sum(1 for i in order if i.split(":", 1)[0] == x["tech"]) >= BATCH:
            break
        for i in ids:
            run(a.bin, repo, env, "decide", i, "do-now")
        run(a.bin, repo, env, "review", "--pass", "upgrade-review", "--next", *tg)
        step += 1
        if step > 60:
            raise SystemExit("%s: more than 60 batches" % ev)
    return [i for i in order if i.split(":", 1)[0] == x["tech"]], None


def score(a, ev, x, order):
    d = os.path.join(a.work, "replay", ev)
    k = json.load(open(os.path.join(d, "key.json")))["items"]
    m = json.load(open(os.path.join(d, "match.json")))
    q = json.load(open(os.path.join(d, "queue.json")))
    to_hid = {r["rid"]: r["id"] for r in q["records"]}
    maps = [r["map"] for r in m["runs"]]
    both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
    req = rr.required_labels(ev)
    first = {to_hid[i] for i in order[:BATCH] if i in to_hid}
    unmapped = [i for i in order[:BATCH] if i not in to_hid]
    out = dict(split=x["split"], tech=x["tech"], first16=order[:BATCH], unmapped16=unmapped)
    for cls, ids in (("all", [i["id"] for i in k]), ("required", [i["id"] for i in k if req.get(i["id"]) is True])):
        out[cls] = sum(1 for i in ids if both[i] & first)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--variant", default="B")
    ap.add_argument("--mode", default="loop", choices=("loop", "dump"))
    ap.add_argument("--split", default="DEV", choices=("DEV", "HELD-OUT", "ALL"))
    ap.add_argument("events", nargs="*")
    a = ap.parse_args()
    a.out, a.work, a.catalog = (os.path.abspath(p) for p in (a.out, a.work, a.catalog))
    evs = events()
    names = a.events or [e for e, x in evs.items() if a.split == "ALL" or x["split"] == a.split]
    res = {}
    for ev in names:
        order, rows = cli_order(a, ev, evs[ev])
        res[ev] = score(a, ev, evs[ev], order)
        if rows is not None:
            t1 = [r for r in rows if r["tech"] == evs[ev]["tech"] and r["tier"] == 1]
            res[ev].update(tier1=len(t1), queue=sum(1 for r in rows if r["tech"] == evs[ev]["tech"]))
        print(ev, res[ev]["split"], "required", res[ev]["required"], "all", res[ev]["all"], flush=True)
    tot = {sp: {c: sum(r[c] for r in res.values() if r["split"] == sp) for c in ("required", "all")} for sp in ("DEV", "HELD-OUT")}
    print(json.dumps(tot))
    os.makedirs(a.out, exist_ok=True)
    json.dump(dict(variant=a.variant, mode=a.mode, totals=tot, events=res), open(os.path.join(a.out, "scores_%s_%s_%s.json" % (a.mode, a.variant, a.split)), "w"), indent=1)
