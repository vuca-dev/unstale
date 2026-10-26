"""Slice 14 round 3 (PREREG.md addendum of 25 October 2026): the fresh confirmation set H3, from a frozen catalog copy.

    python3 build_h3.py select <catalog-dir> <stacks.json>     # technologies (no record content read)
    python3 build_h3.py sample <catalog-dir>                   # records, states and the labelling packet

Writes h3/technologies.json, h3/records.json (id, technology, stratum, state) and h3/packet-records.json (id,
technology name and state only, shuffled). Stdlib only. `state()` is also the rebuild the UX replay uses.
"""
import glob, gzip, hashlib, json, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "h3")
SEED = "unstale-holdout-v3"
N_TECH = {"npm": 3, "pypi": 3}
N_TOTAL = 6  # deviation 1 (RESULTS): when an ecosystem has fewer eligible technologies, the next npm ones fill the six
N_REC = 70
O_FLOOR = 0.15
O_RE = re.compile(r"break|deprecat|remov|migrat|upgrad", re.I)
SOURCE = {"upgrade_guide": "upgrade guide", "docs": "official documentation change"}


def H(kind, i):
    return hashlib.sha256(("%s:%s:%s" % (SEED, kind, i)).encode()).hexdigest()


def records_of(cat, tech):
    out = []
    for f in sorted(glob.glob(os.path.join(cat, "v1", "shards", tech, "*.jsonl.gz"))):
        out += [json.loads(l) for l in gzip.open(f)]
    return out


def state(name, r):
    """labels.ts recordState, rebuilt from a catalog record (first release, first evidence)."""
    e = r["evidence"][0]
    s = {"technology": name, "source": SOURCE.get(e.get("kind"), "release notes"), "release": r["releases"][0]["version"], "subject": r["subject"]}
    if r.get("facet"):
        s["facet"] = r["facet"]
    s["summary"] = r["summary"]
    s["evidence"] = e.get("quote", "")
    if e.get("section"):
        s["section"] = e["section"]
    s["introduces"] = r.get("introduces", [])
    s["replaces"] = r.get("replaces", [])
    return s


def name_of(idx):
    p = idx["components"][0]
    return re.sub(r"^pkg:(npm|pypi)/", "", p).replace("%40", "@")


def eval_text():
    """Every file under eval/ except eval/repos, eval/rarity-sample* and eval/select/out (H1 rule 2, plus eval/select's
    committed files, which name other slices' sets), lower-cased."""
    parts = []
    for root, dirs, files in os.walk(EVAL):
        rel = os.path.relpath(root, EVAL)
        if rel.split(os.sep)[0] in ("repos",) or rel.startswith("rarity-sample") or rel.startswith(os.path.join("select", "out")) or rel.startswith(os.path.join("select", "slice14", "h3")):
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
        for f in files:
            if f.endswith((".gz", ".png", ".bin", ".pt", ".onnx")):
                continue
            try:
                parts.append(open(os.path.join(root, f), encoding="utf-8", errors="ignore").read().lower())
            except OSError:
                pass
    return "\n".join(parts)


def select(cat, stacks_path):
    stacks = set(json.load(open(stacks_path)))
    text = eval_text()
    techs = json.load(open(os.path.join(cat, "v1", "technologies.json")))["technologies"]
    rows = []
    for t in sorted(techs, key=lambda t: H("tech", t)):
        p = os.path.join(cat, "v1", "tech", t + ".json")
        if not os.path.exists(p):
            continue
        idx = json.load(open(p))
        comps = idx.get("components", [])
        eco = "npm" if comps and comps[0].startswith("pkg:npm/") else "pypi" if comps and comps[0].startswith("pkg:pypi/") else None
        if not eco or t in stacks:
            continue
        name = name_of(idx).lower()
        recs = [r for r in records_of(cat, t) if r.get("status", "active") == "active" and r["evidence"] and r["evidence"][0].get("kind") == "release_notes"]
        if len(recs) < 150 or len(idx.get("releases", [])) < 10:
            continue
        repos = {m.group(1).lower() for r in recs[:50] for e in r["evidence"] for m in [re.search(r"github\.com/([^/]+/[^/#?]+)", e.get("url", ""))] if m}
        needles = [t.lower(), ("pkg:%s/%s" % (eco, name)) if len(name) < 4 else name] + sorted(repos)
        if any(n in text for n in needles):
            continue
        rows.append({"technology": t, "ecosystem": eco, "name": name_of(idx), "records": len(recs), "releases": len(idx["releases"]), "repos": sorted(repos)})
    picks = []
    for eco, k in N_TECH.items():
        picks += [r for r in rows if r["ecosystem"] == eco][:k]
    picks += [r for r in rows if r not in picks][: N_TOTAL - len(picks)]
    os.makedirs(OUT, exist_ok=True)
    json.dump({"_rule": "PREREG.md addendum 25 October 2026, H3", "picks": picks, "eligible": len(rows)}, open(os.path.join(OUT, "technologies.json"), "w"), indent=1)
    print(json.dumps(picks, indent=1), "eligible", len(rows))


def sample(cat):
    picks = json.load(open(os.path.join(OUT, "technologies.json")))["picks"]
    out = []
    for p in picks:
        recs = [r for r in records_of(cat, p["technology"]) if r.get("status", "active") == "active" and r["evidence"] and r["evidence"][0].get("kind") == "release_notes"]
        strat = {"O": [], "R": []}
        for r in sorted(recs, key=lambda r: H("rec", r["id"])):
            strat["O" if O_RE.search(r["evidence"][0].get("section") or "") else "R"].append(r)
        nat = len(strat["O"]) / len(recs)
        n_o = min(len(strat["O"]), max(round(O_FLOOR * N_REC), round(nat * N_REC)))
        seen, take = set(), []
        for s, n in (("O", n_o), ("R", N_REC - n_o)):
            k = 0
            for r in strat[s]:
                if k >= n:
                    break
                st = state(p["name"], r)
                key = json.dumps(st, sort_keys=True)
                if key in seen:
                    continue
                seen.add(key)
                take.append({"id": r["id"], "technology": p["technology"], "stratum": s, "state": st})
                k += 1
        print(p["technology"], "natural O %.3f" % nat, "O", n_o, "taken", len(take))
        out += take
    json.dump({"records": out}, open(os.path.join(OUT, "records.json"), "w"), indent=1)
    pk = [{"id": r["id"], "technology": r["state"]["technology"], "state": r["state"]} for r in out]
    random.Random(SEED).shuffle(pk)
    json.dump({"records": pk}, open(os.path.join(OUT, "packet-records.json"), "w"), indent=1)
    print("records", len(out))


if __name__ == "__main__":
    {"select": lambda: select(sys.argv[2], sys.argv[3]), "sample": lambda: sample(sys.argv[2])}[sys.argv[1]]()
