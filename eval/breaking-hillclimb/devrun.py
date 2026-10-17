"""Dev metric for one set of breaking labels: relabel a COPY of the store, republish its catalog, rerun the replay
queue (no model), and score with the final replay's two Codex match runs (not re-matched).

    python3 devrun.py <hc dir> <name> <labels.json> [--record-level]

Labels map an incoming extraction key (or, with --record-level, a record id) to {"choice": "yes"|"no"}. A record is
breaking if any of its extractions is (the pipeline's combine rule); records outside the event windows keep their
catalog label. Writes <hc>/runs/<name>/dev.json. Never writes under ~/unstale/.store.
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CENTRAL = os.path.join(HERE, "..", "..", "central")
REPLAY = os.path.join(HERE, "..", "replay", "run_replay.py")
# The replay work directory (fw/ and replay/ from a prior run_replay.py queue); required.
FINAL = os.environ.get("HC_FINAL", "")
BATCH = 16


def main(hc, name, labels_path, record_level=False):
    if not FINAL:
        sys.exit("set HC_FINAL to the replay work directory")
    man = json.load(open(os.path.join(hc, "dev_manifest.json")))
    labels = json.load(open(labels_path))
    run = os.path.join(hc, "runs", name)
    if os.path.exists(run):
        shutil.rmtree(run)
    os.makedirs(run)
    store = os.path.join(run, "store")
    subprocess.run(["cp", "-cR", os.path.join(hc, "store-base"), store], check=True)
    assert os.path.realpath(store).startswith(os.path.realpath(hc))
    flips = {}
    for ev, e in man.items():
        p = os.path.join(store, "central", "records", "%s.json" % e["tech"])
        st = json.load(open(p))
        n = 0
        for rec in e["records"].values():
            r = st["records"][rec["rid"]]
            if record_level:
                new = labels[rec["rid"]]["choice"] == "yes"
            else:
                new = any(labels[s]["choice"] == "yes" for s in rec["sources"])
            if new != r["breaking"]:
                n += 1
            r["breaking"] = new
        flips[ev] = n
        # same serialisation as store.saveStore (records already sorted; keys unchanged)
        open(p, "w").write(json.dumps(st, indent=1, ensure_ascii=False) + "\n")
    env = dict(os.environ, UNSTALE_STORE=store)
    env.pop("UNSTALE_CENTRAL_DIR", None)
    env.pop("UNSTALE_CATALOG_DIR", None)
    subprocess.run(["npx", "tsx", "src/pipeline/cli.ts", "publish"], cwd=CENTRAL, env=env, check=True, stdout=subprocess.DEVNULL)
    work = os.path.join(run, "work")
    os.makedirs(os.path.join(work, "replay"))
    subprocess.run(["cp", "-cR", os.path.join(FINAL, "fw"), os.path.join(work, "fw")], check=True)
    subprocess.run(["cp", "-cR", os.path.join(FINAL, "replay", "full"), os.path.join(work, "replay", "full")], check=True)
    for ev in man:
        d = os.path.join(work, "replay", ev)
        os.makedirs(d)
        for f in ("key.json", "match.json"):
            subprocess.run(["cp", "-c", os.path.join(FINAL, "replay", ev, f), os.path.join(d, f)], check=True)
        subprocess.run(["cp", "-cR", os.path.join(FINAL, "replay", ev, "snap"), os.path.join(d, "snap")], check=True)
    q = subprocess.run([sys.executable, REPLAY, "--catalog", os.path.join(store, "catalog"), "--work", work, "queue"],
                       capture_output=True, text=True)
    if q.returncode:
        sys.exit(q.stderr[-2000:])
    res = dict(name=name, labels=labels_path, record_flips=flips, events={})
    for ev in man:
        d = os.path.join(work, "replay", ev)
        k = json.load(open(os.path.join(d, "key.json")))["items"]
        m = json.load(open(os.path.join(d, "match.json")))
        qu = json.load(open(os.path.join(d, "queue.json")))
        m["in_queue"] = [r["id"] for r in qu["records"]]          # the match runs are reused; only the queue moved
        json.dump(m, open(os.path.join(d, "match.json"), "w"), indent=1)
        maps = [r["map"] for r in m["runs"]]
        both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
        inq = set(m["in_queue"])
        covered = sorted(i for i, s in both.items() if s)
        queued = sorted(i for i, s in both.items() if s & inq)
        order = qu["orders"]["tier"]
        top = set(order[:BATCH])
        by = {r["id"]: r for r in qu["records"]}
        res["events"][ev] = dict(
            covered=len(covered), queued=len(queued), first16=sum(1 for i in queued if both[i] & top),
            first16_ids=sorted(i for i in queued if both[i] & top), queue=qu["counts"]["queue"], tiers=qu["counts"]["tiers"],
            entries={i: [dict(id=x, rank=(order.index(x) + 1) if x in order else None, tier=by[x]["tier"] if x in by else None,
                           breaking=by[x]["breaking"] if x in by else None) for x in sorted(both[i])] for i in covered})
    res["total"] = dict(covered=sum(e["covered"] for e in res["events"].values()), queued=sum(e["queued"] for e in res["events"].values()),
                        first16=sum(e["first16"] for e in res["events"].values()),
                        tier0={ev: e["tiers"]["0"] for ev, e in res["events"].items()})
    json.dump(res, open(os.path.join(run, "dev.json"), "w"), indent=1)
    print(name, json.dumps(res["total"]), "flips", flips, {ev: e["first16"] for ev, e in res["events"].items()})


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    main(a[0], a[1], a[2], "--record-level" in sys.argv)
