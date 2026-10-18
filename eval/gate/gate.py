"""Release gate: the replay scored on the order the shipped CLI hands a user.

The replay (eval/replay/run_replay.py over ~/ati-slice0/harness/replay.py) builds its queue in Python. Users get the
Rust CLI's upgrade-review order (local/cli funnel.rs), which differs (see eval/gate/README.md). This script takes the
queue from the CLI binary itself, with no CLI change: in a copy of the event repository at P it runs `unstale init`,
`sync` and `review --pass upgrade-review --target <pkg>@<new>`, reads the batch from `.unstale/state/review.json`,
marks every record of it `decide <id> do-now` (review state only: no ledger line, so the funnel's order is
unchanged) and asks `review --next` until the queue is empty. Concatenated batches = the CLI's whole order.

Stages (each cached; rerun skips finished work):
    cliqueue  the CLI's order per event                               (no model call)
    agree     CLI order vs the harness queue (rarity_queue.py fallback weights) (no model call)
    match     key changes -> catalog entries, 2 Codex runs (reused from --reuse-match when the catalog text is identical)
    review    the replay's upgrade-review skill over the CLI's first 16 (`tier`) and whole queue (`all`), K runs
    score     metrics per split and per required/optional, run-to-run spread -> --out JSON (see score.py for tables)

    python3 gate.py --catalog DIR --work DIR --bin UNSTALE [--k 3] [--jobs 4] STAGE [event ...]

Model calls go through ~/ati-slice0/harness e2e_run._codex (codex exec, gpt-5.6-luna), cached by request hash under
$GATE_CACHE (default ~/.cache/unstale-gate) and logged to <work>/gate-usage.jsonl.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "replay"))
import run_replay as rr  # noqa: E402

replay, f = rr.replay, rr.f
from e2e_queue import package_of, vtuple  # noqa: E402
from e2e_run import _codex, _id, render, verdicts  # noqa: E402
from config import MODEL  # noqa: E402

TARGET_PKGS = {"next": ["next"], "prisma": ["prisma", "@prisma/client"], "nestjs": ["@nestjs/core", "@nestjs/common"]}
TODAY = "2026-10-15"
CACHE = os.path.expanduser(os.environ.get("GATE_CACHE", "~/.cache/unstale-gate"))
BATCH = 16


def sh(*a, **k):
    return subprocess.run(a, capture_output=True, text=True, **k)


def gdir(e):
    return os.path.join(e["dir"], "gate")


def rows_by_rid(tech):
    return {r["rid"]: r for r in f.relabelled(f.records(tech), "v2")}


def set_window(ev):
    e = replay.EVENTS[ev]
    rr.WINDOW[e["tech"]] = (e["old"], e["new"])


# ---------------------------------------------------------------------------------------------------- CLI queue

# The summary sits in a fenced block (with any conditions on the next line), so upstream text cannot pose as instructions.
# No part crosses into the next entry: an "In effect now" entry has another release line and must not swallow it.
REC = re.compile(r"^### \[([^\]]+)\] rev (\d+)\n\n`{3,}text\n((?:(?!\n### ).)*?)\n(?:Conditions [^\n]*\n)?`{3,}\n\n- Release: (\S+) (\S+) \(installed (\S+), target (\S+)\)\n- Change: ([^;]+); breaking: (yes|no)\n"
                 r"(?:(?!### )[^\n]*\n)*?- (?:Matched terms|Deprecated API used here): (.*?)\n", re.M | re.S)


def cli_queue(ev, binary, catalog):
    e = replay.info(ev)
    snap = replay.snapshot(e)
    d = gdir(e)
    out = os.path.join(d, "queue_cli.json")
    bsum = hashlib.sha256(open(binary, "rb").read()).hexdigest()
    if os.path.exists(out) and json.load(open(out)).get("bin_sha256") == bsum:
        return json.load(open(out))
    repo = os.path.join(d, "repo")
    shutil.rmtree(repo, ignore_errors=True)
    shutil.rmtree(os.path.join(d, "cache"), ignore_errors=True)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["cp", "-cR", snap, repo], check=True)
    env = dict(os.environ, UNSTALE_CACHE_DIR=os.path.join(d, "cache"), UNSTALE_TODAY=TODAY)
    env.pop("UNSTALE_CATALOG", None)
    run = lambda *a: subprocess.run([binary, *a], cwd=repo, env=env, capture_output=True, text=True)  # noqa: E731
    for args in (("init", "--catalog", catalog, "--yes"), ("sync",)):
        p = run(*args)
        if p.returncode != 0:
            sys.exit("%s: unstale %s failed: %s" % (ev, args[0], p.stderr[-500:]))
    targets = [x for p in TARGET_PKGS[e["tech"]] for x in ("--target", "%s@%s" % (p, e["new"]))]
    order, recs, first = [], {}, True
    skill = os.path.join(repo, ".unstale", "skills", "upgrade-review", "SKILL.md")
    while True:
        p = run("review", "--pass", "upgrade-review", *targets, *([] if first else ["--next"]))
        if p.returncode != 0:
            sys.exit("%s: unstale review failed (%d): %s" % (ev, p.returncode, p.stderr[-500:]))
        first = False
        state = json.load(open(os.path.join(repo, ".unstale", "state", "review.json")))
        ids = state["batches"]["upgrade-review"]["ids"]
        if not ids:
            break
        text = open(skill).read()
        for m in REC.finditer(text):
            recs[m.group(1)] = dict(rev=int(m.group(2)), pkg=m.group(4), release=m.group(5), installed=m.group(6), target=m.group(7),
                                    change=m.group(8), breaking=m.group(9) == "yes", matched=m.group(10) != "none")
        assert all(i in recs for i in ids), (ev, [i for i in ids if i not in recs])
        order += ids
        for i in ids:
            q = run("decide", i, "do-now")
            if q.returncode != 0:
                sys.exit("%s: decide %s failed: %s" % (ev, i, q.stderr[-300:]))
    assert len(order) == len(set(order)), ev
    ver = sh(binary, "--version").stdout.strip()
    res = dict(event=ev, bin=binary, bin_sha256=bsum, version=ver, targets=targets, today=TODAY,
               order_all=order, order=[i for i in order if i.startswith(e["tech"] + ":")], records=recs,
               other_tech_in_first16=sum(1 for i in order[:BATCH] if not i.startswith(e["tech"] + ":")))
    json.dump(res, open(out, "w"), indent=1)
    shutil.rmtree(repo, ignore_errors=True)
    print("cliqueue", ev, "queue", len(res["order"]), "(all techs %d, other techs in first 16: %d)" % (len(order), res["other_tech_in_first16"]), flush=True)
    return res


# ---------------------------------------------------------------------------------------------------- agreement

def agree(ev):
    """CLI order vs the harness queue in <work>/replay/<ev>/queue.json (rarity_queue.py --weights fallback)."""
    e = replay.info(ev)
    q = json.load(open(os.path.join(e["dir"], "queue.json")))
    c = json.load(open(os.path.join(gdir(e), "queue_cli.json")))
    by = rows_by_rid(e["tech"])
    hid = {rid: _id(r) for rid, r in by.items()}
    cli = [hid[i] for i in c["order"]]
    har_all = q["orders"]["tier"]
    hrec = {r["id"]: r for r in q["records"]}
    # the harness queue restricted to what the CLI's pass can hold (obligations: breaking, removal, deprecation)
    har_obl = [i for i in har_all if hrec[i]["tier"] <= 1]
    s_cli, s_har, s_obl = set(cli), set(har_all), set(har_obl)
    top_c, top_h, top_o = set(cli[:BATCH]), set(har_all[:BATCH]), set(har_obl[:BATCH])
    only_cli = sorted(s_cli - s_har)
    only_har_obl = sorted(s_obl - s_cli)
    same_set_order = [i for i in cli if i in s_obl]
    same_obl_order = [i for i in har_obl if i in s_cli]
    return dict(event=ev, cli=len(cli), harness=len(har_all), harness_obligations=len(har_obl),
                both=len(s_cli & s_har), only_cli=only_cli, only_harness_obligation=only_har_obl,
                first16_overlap=len(top_c & top_h), first16_overlap_obligations=len(top_c & top_o),
                identical_order_on_common=same_set_order == same_obl_order,
                why_only_cli={i: _why_cli(i, by, e, c) for i in only_cli},
                why_only_harness={i: _why_har(i, hrec, e, c, by) for i in only_har_obl})


def _rid_of(hid_, by):
    for rid, r in by.items():
        if _id(r) == hid_:
            return rid
    return None


def _why_cli(i, by, e, c):
    rid = _rid_of(i, by)
    r = by[rid]
    inwin = vtuple(e["old"]) < vtuple(r["release"]) <= vtuple(e["new"])
    x = c["records"][rid]
    return "harness release %s (%s window), CLI release %s installed %s" % (r["release"], "in" if inwin else "outside", x["release"], x["installed"])


def _why_har(i, hrec, e, c, by):
    rid = hrec[i]["rid"]
    if rid in c["records"]:
        return "in CLI queue"
    raw = {x["rid"]: x for x in by.values()}[rid]
    return "harness release %s; breaking=%s change_type=%s" % (raw["release"], raw.get("breaking"), raw.get("change_type"))


# ---------------------------------------------------------------------------------------------------- Codex, cached

class UsageLimit(RuntimeError):
    """Codex answered that the account's usage limit is reached: stop instead of failing every remaining job."""


def cached_codex(kind, key_obj, cwd, prompt, log):
    h = hashlib.sha256(json.dumps(dict(kind=kind, model=MODEL, **key_obj), sort_keys=True).encode()).hexdigest()
    p = os.path.join(CACHE, kind, h[:2], h + ".json")
    if os.path.exists(p):
        meta = json.load(open(p))
        with open(log, "a") as fh:
            fh.write(json.dumps(dict(kind=kind, hash=h, cached=True)) + "\n")
        return meta
    proc, meta = _codex(cwd, prompt, "read-only")
    if proc.returncode != 0 or not meta["usage"] or not meta["final"]:
        limit = "usage limit" in proc.stdout
        with open(log, "a") as fh:
            fh.write(json.dumps(dict(kind=kind, hash=h, cached=False, failed=True, usage_limit=limit, usage=meta["usage"])) + "\n")
        if limit:
            raise UsageLimit(re.findall(r"try again at [^.\"]+", proc.stdout)[:1])
        return None
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(meta, open(p, "w"))
    with open(log, "a") as fh:
        fh.write(json.dumps(dict(kind=kind, hash=h, cached=False, usage=meta["usage"], wall_s=meta["wall_s"])) + "\n")
    return meta


def tree_of(snap):
    return sh("git", "-C", snap, "rev-parse", "HEAD^{tree}").stdout.strip()


# ---------------------------------------------------------------------------------------------------- match

def match_catalog(ev):
    """The replay's match catalog (every window record of the event's package, as replay.match builds it) plus any
    record in the CLI queue that the replay's window test leaves out."""
    e = replay.info(ev)
    by = rows_by_rid(e["tech"])
    win = [r for r in by.values() if package_of(r) == e["package"] and vtuple(e["old"]) < vtuple(r["release"]) <= vtuple(e["new"])]
    c = json.load(open(os.path.join(gdir(e), "queue_cli.json")))
    win_ids = {_id(r) for r in win}
    extra = [by[i] for i in c["order"] if _id(by[i]) not in win_ids]
    seen, cat = set(), []
    for r in sorted(win, key=lambda r: r["date"]) + extra:
        if _id(r) not in seen:
            seen.add(_id(r))
            cat.append(r)
    cat.sort(key=_id)
    return cat, [_id(r) for r in extra]


def match(ev, work, reuse=None):
    e = replay.info(ev)
    out = os.path.join(gdir(e), "match.json")
    if os.path.exists(out):
        return
    k = json.load(open(os.path.join(e["dir"], "key.json")))
    cat, extra_ids = match_catalog(ev)
    n_extra = len(extra_ids)
    ids = [_id(r) for r in cat]
    if reuse:
        # An earlier match over the same window (the replay's own match catalog) is reused. Records the CLI queues
        # outside the event window (a library's peer-range floor below the event's old version) are then left
        # unmatched: they were released before the version the project had locked, so no maintainer change of this
        # upgrade responds to them.
        p = next((x for x in (os.path.join(reuse, ev + ".json"), os.path.join(reuse, ev, "match.json")) if os.path.exists(x)), "")
        win_ids = sorted({_id(r) for r in cat} - set(extra_ids))
        if os.path.exists(p) and json.load(open(p))["catalog"] in (ids, win_ids):
            m = json.load(open(p))
            json.dump(dict(event=ev, runs=m["runs"], catalog=m["catalog"], reused=p, unmatched_cli_records=sorted(set(ids) - set(m["catalog"]))),
                      open(out, "w"), indent=1)
            print("match", ev, "reused", p, "unmatched CLI records outside the window:", len(set(ids) - set(m["catalog"])), flush=True)
            return
    keytxt = "\n".join("- [%s] %s (%s). Responds to: %s" % (i["id"], i["change"], ", ".join(i.get("files") or [])[:200], i.get("responds_to"))
                       for i in k["items"])
    prompt = replay.MATCH % dict(e, key=keytxt, catalog="\n".join(render(r) for r in cat))
    cwd = os.path.join(gdir(e), "match_cwd")
    os.makedirs(cwd, exist_ok=True)
    runs = []
    for rep in (1, 2):
        meta = cached_codex("match", dict(prompt=prompt, rep=rep), cwd, prompt, os.path.join(work, "gate-usage.jsonl"))
        if meta is None:
            sys.exit("match failed: %s rep %d" % (ev, rep))
        runs.append(dict(map=replay._json(meta["final"]), **meta))
    json.dump(dict(event=ev, runs=runs, catalog=ids, extra_cli_records=n_extra), open(out, "w"), indent=1)
    print("match", ev, [sum(bool(v) for v in r["map"].values()) for r in runs], "of", len(k["items"]), flush=True)


# ---------------------------------------------------------------------------------------------------- review

def review_jobs(ev, arms, K):
    e = replay.info(ev)
    c = json.load(open(os.path.join(gdir(e), "queue_cli.json")))
    by = rows_by_rid(e["tech"])
    jobs = []
    for arm in arms:
        rids = c["order"][:BATCH] if arm == "tier" else c["order"]
        recs = sorted((by[i] for i in rids), key=_id)          # the agent sees no order
        skill = replay.SKILL % dict(e, catalog="\n".join(render(r) for r in recs))
        for rep in range(1, K + 1):
            jobs.append((ev, arm, rep, [_id(r) for r in recs], skill))
    return jobs


def review_key(skill, snap, arm, rep):
    # the arm is part of the key: when the whole queue is 16 records, `tier` and `all` send the same skill, and
    # their runs must stay independent samples
    return dict(skill=skill, tree=tree_of(snap), arm=arm, rep=rep)


def seed_cache(evs):
    """Write cache entries from finished runs' review.json (e.g. runs made before the cache key changed)."""
    n = 0
    for ev in evs:
        e = replay.info(ev)
        runs = os.path.join(gdir(e), "runs")
        for name in sorted(os.listdir(runs)) if os.path.isdir(runs) else []:
            p = os.path.join(runs, name, "review.json")
            if not os.path.exists(p):
                continue
            rv = json.load(open(p))
            h = hashlib.sha256(json.dumps(dict(kind="review", model=MODEL, **review_key(rv["skill"], replay.snapshot(e), rv["arm"], rv["rep"])),
                                          sort_keys=True).encode()).hexdigest()
            c = os.path.join(CACHE, "review", h[:2], h + ".json")
            if not os.path.exists(c):
                os.makedirs(os.path.dirname(c), exist_ok=True)
                json.dump({k: rv[k] for k in ("wall_s", "usage", "n_commands", "final", "commands") if k in rv}, open(c, "w"))
                n += 1
    print("seeded", n, "cache entries")


def review_one(job, work):
    ev, arm, rep, ids, skill = job
    e = replay.info(ev)
    rdir = os.path.join(gdir(e), "runs", "%s__%02d" % (arm, rep))
    if os.path.exists(os.path.join(rdir, "review.json")):
        return "skip"
    snap = replay.snapshot(e)
    os.makedirs(rdir, exist_ok=True)
    wd = os.path.join(rdir, "repo")
    shutil.rmtree(wd, ignore_errors=True)
    subprocess.run(["cp", "-cR", snap, wd], check=True)
    subprocess.run(["git", "reset", "-q", "--hard"], cwd=wd, check=True)
    subprocess.run(["git", "clean", "-qfdx"], cwd=wd, check=True)
    path = os.path.join(wd, ".agents/skills/upgrade-review/SKILL.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(skill)
    try:
        meta = cached_codex("review", review_key(skill, snap, arm, rep), wd, "Run an upgrade review of this repository.",
                            os.path.join(work, "gate-usage.jsonl"))
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    if meta is None:
        return "FAILED %s %s %d" % (ev, arm, rep)
    json.dump(dict(event=ev, arm=arm, rep=rep, ids=ids, skill=skill, **meta), open(os.path.join(rdir, "review.json"), "w"), indent=1)
    return "ok %s %s %d in=%s wall=%ss" % (ev, arm, rep, meta["usage"].get("input_tokens"), meta["wall_s"])


# ---------------------------------------------------------------------------------------------------- score

def score(evs, K, arms):
    rows = {}
    for ev in evs:
        e = replay.info(ev)
        g = gdir(e)
        k = json.load(open(os.path.join(e["dir"], "key.json")))["items"]
        m = json.load(open(os.path.join(g, "match.json")))
        c = json.load(open(os.path.join(g, "queue_cli.json")))
        by = rows_by_rid(e["tech"])
        cli = [_id(by[i]) for i in c["order"]]
        maps = [r["map"] for r in m["runs"]]
        both = {i["id"]: set(maps[0].get(i["id"], [])) & set(maps[1].get(i["id"], [])) for i in k}
        req = rr.required_labels(ev)
        cls = {i["id"]: ("required" if req.get(i["id"]) is True else "optional" if req.get(i["id"]) is False else "unlabelled") for i in k}
        key_ids = set().union(*both.values()) if both else set()
        inq, top = set(cli), set(cli[:BATCH])
        # as invoked: `--target` names only the event's packages, so other catalog technologies in the repository
        # default to their newest release and their obligations share the first batch
        top_inv = {_id(by[i]) for i in c["order_all"][:BATCH] if i in by}
        det = {}
        for name in ("all", "required", "optional"):
            ids = [i["id"] for i in k if name == "all" or cls[i["id"]] == name]
            det[name] = dict(key=len(ids), covered=sum(1 for i in ids if both[i]), queued=sum(1 for i in ids if both[i] & inq),
                             first16=sum(1 for i in ids if both[i] & top), first16_invoked=sum(1 for i in ids if both[i] & top_inv))
        row = dict(split=rr.NEW_EVENTS.get(ev, {}).get("split") or rr.ORIG_SPLIT.get(ev), tech=e["tech"], queue=len(cli),
                   other_tech_in_first16=c["other_tech_in_first16"], deterministic=det, reviews={},
                   per_key={i["id"]: dict(cls=cls[i["id"]], covered=bool(both[i["id"]]), queued=bool(both[i["id"]] & inq),
                                          first16=bool(both[i["id"]] & top), rank=min((cli.index(x) + 1 for x in both[i["id"]] if x in inq), default=None))
                            for i in k})
        for arm in arms:
            for rep in range(1, K + 1):
                p = os.path.join(g, "runs", "%s__%02d" % (arm, rep), "review.json")
                if not os.path.exists(p):
                    continue
                rv = json.load(open(p))
                v = verdicts(rv["final"], rv["ids"])
                batch = set(rv["ids"])
                r = dict(batch=len(rv["ids"]), tokens=rv["usage"].get("input_tokens") or 0, cached_tokens=rv["usage"].get("cached_input_tokens") or 0,
                         output_tokens=rv["usage"].get("output_tokens") or 0, wall=rv["wall_s"],
                         do_now=sum(x == "do now" for x in v.values()), later=sum(x == "later" for x in v.values()),
                         missing=sum(x == "missing" for x in v.values()),
                         do_now_off_key=sorted(x for x, y in v.items() if y == "do now" and x not in key_ids), classes={})
                for name in ("all", "required", "optional"):
                    ids = [i["id"] for i in k if name == "all" or cls[i["id"]] == name]
                    r["classes"][name] = dict(
                        in_batch=sum(1 for i in ids if both[i] & batch),
                        found=sum(1 for i in ids if any(v.get(x) in ("do now", "later") for x in both[i] & batch)),
                        found_now=sum(1 for i in ids if any(v.get(x) == "do now" for x in both[i] & batch)))
                r["found_ids"] = sorted(i["id"] for i in k if any(v.get(x) in ("do now", "later") for x in both[i["id"]] & batch))
                row["reviews"]["%s__%02d" % (arm, rep)] = r
        rows[ev] = row
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--bin", default=os.environ.get("UNSTALE_BIN", "unstale"))
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--arms", default="tier,all")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--reuse-match", help="dir with <event>/match.json from an earlier run on the same catalog text")
    ap.add_argument("--out")
    ap.add_argument("stage", choices=("cliqueue", "agree", "match", "review", "score", "seedcache"))
    ap.add_argument("events", nargs="*")
    a = ap.parse_args()
    evs = a.events or list(rr.SETS["all"])
    work, catalog = os.path.abspath(a.work), os.path.abspath(a.catalog)
    binary = shutil.which(a.bin) or os.path.abspath(a.bin)
    rr.install(catalog, work, "orig")
    arms = tuple(a.arms.split(","))
    if a.stage == "review":
        jobs = []
        for ev in evs:
            set_window(ev)
            jobs += review_jobs(ev, arms, a.k)
        # windows differ per event of one technology: run each technology's events in turn, parallel within
        by_tech = {}
        for j in jobs:
            by_tech.setdefault(replay.EVENTS[j[0]]["tech"], []).append(j)
        for tech, js in by_tech.items():
            for ev in {j[0] for j in js}:
                replay.snapshot(replay.info(ev))
            stop = []

            def run(j):
                if stop:
                    return "not started (usage limit) %s %s %d" % j[:3]
                try:
                    return review_one(j, work)
                except UsageLimit as x:
                    stop.append(x)
                    return "USAGE LIMIT %s %s %d %s" % (*j[:3], x)
            with cf.ThreadPoolExecutor(a.jobs) as ex:
                for r in ex.map(run, js):
                    print(r, flush=True)
            if stop:
                sys.exit("stopped: Codex usage limit (%s); rerun to continue (finished reviews are kept)" % stop[0])
        return
    if a.stage == "seedcache":
        seed_cache(evs)
        return
    if a.stage == "score":
        rows = {}
        for ev in evs:
            set_window(ev)
            rows.update(score([ev], a.k, arms))
        out = a.out or os.path.join(work, "gate_score.json")
        json.dump(dict(catalog=catalog, bin=binary, k=a.k, arms=list(arms), events=rows), open(out, "w"), indent=1)
        print("wrote", out)
        return
    res = []
    for ev in evs:
        set_window(ev)
        if a.stage == "cliqueue":
            cli_queue(ev, binary, catalog)
        elif a.stage == "agree":
            res.append(agree(ev))
        elif a.stage == "match":
            match(ev, work, a.reuse_match)
    if a.stage == "agree":
        out = a.out or os.path.join(work, "gate_agree.json")
        json.dump(res, open(out, "w"), indent=1)
        for r in res:
            print("%-22s cli %3d harness %3d (obligations %3d) both %3d only-cli %2d only-harness-obl %2d first16 overlap %2d / obl %2d same-order %s" % (
                r["event"], r["cli"], r["harness"], r["harness_obligations"], r["both"], len(r["only_cli"]), len(r["only_harness_obligation"]),
                r["first16_overlap"], r["first16_overlap_obligations"], r["identical_order_on_common"]))


if __name__ == "__main__":
    main()
