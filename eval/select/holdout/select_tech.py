"""Held-out technology selection (PREREG.md section 1). Reads heading lines only. Writes out/holdout/selection-*.json."""
import glob, hashlib, json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SEED = "unstale-holdout-v1"
OUT = os.path.join(ROOT, "eval/select/out/holdout")
H = lambda kind, i: hashlib.sha256(f"{SEED}:{kind}:{i}".encode()).hexdigest()
HEAD = re.compile(r"^#{1,6}\s+(.*)$")
CHANGESETS = re.compile(r"^(major|minor|patch) changes$", re.I)
EXCLUDED = {"next", "prisma", "nestjs", "nuxt", "laravel", "node", "fastify"}
SKIP_DIRS = ("eval/select", "eval/repos", "eval/rarity-sample")


def headings(text):
    return [m.group(1).strip() for l in text.split("\n") if (m := HEAD.match(l))]


def eval_corpus():
    out = []
    for dp, dn, fn in os.walk(os.path.join(ROOT, "eval")):
        rel = os.path.relpath(dp, ROOT)
        if any(rel.startswith(s) for s in SKIP_DIRS) or "node_modules" in rel or "__pycache__" in rel:
            dn[:] = []
            continue
        for f in fn:
            try:
                out.append((os.path.join(rel, f), open(os.path.join(dp, f), encoding="utf8", errors="ignore").read().lower()))
            except OSError:
                pass
    return out


def npm():
    jobs = {}
    for f in glob.glob(os.path.join(ROOT, ".store/central/onboarding/jobs/*.json")):
        j = json.load(open(f))
        jobs[j["technology"]] = j
    corpus = eval_corpus()
    rows = []
    for f in sorted(glob.glob(os.path.join(ROOT, ".store/central/records/*.json"))):
        d = json.load(open(f))
        t = d["technology"]
        j = jobs.get(t)
        purl = (j or {}).get("purl") or ""
        if not purl.startswith("pkg:npm/"):
            rows.append({"id": t, "eligible": False, "why": "not an onboarded npm technology"})
            continue
        desc = j.get("descriptor") or {}
        name = purl[len("pkg:npm/"):].replace("%40", "@")
        repo = (desc.get("repo") or "").lower()
        rows.append({"id": t, "name": name, "repo": repo, "records": d["records"]})
    excluded_repos = set()
    for r in rows:
        if "name" not in r:
            continue
        terms = [r["id"].lower()] + ([r["repo"]] if r["repo"] else [])
        nm = r["name"].lower()
        terms += [f"pkg:npm/{nm}"] if len(nm.split("/")[-1]) < 4 else [nm, nm.split("/")[-1]] if len(nm.split("/")[-1]) >= 4 else [nm]
        hits = sorted({p for p, txt in corpus for term in terms if term in txt})
        r["eval_hits"] = hits[:5]
        if r["id"] in EXCLUDED or hits:
            r["eligible"] = False
            r["why"] = "excluded id" if r["id"] in EXCLUDED else f"named in {hits[:3]}"
            if r["repo"]:
                excluded_repos.add(r["repo"])
    for x in ["vercel/next.js", "prisma/prisma", "nestjs/nest", "nuxt/nuxt", "laravel/framework", "nodejs/node", "fastify/fastify"]:
        excluded_repos.add(x)
    out = []
    for r in rows:
        if "name" not in r:
            out.append(r)
            continue
        recs = r.pop("records")
        active = [x for x in recs.values() if x["status"] == "active"]
        rn = [x for x in active if x.get("sources") and "+" not in x["sources"][0] and "@" in x["sources"][0]]
        rdir = os.path.join(ROOT, ".store/central/releases", r["id"])
        files = sorted(f for f in os.listdir(rdir) if f.endswith(".md")) if os.path.isdir(rdir) else []
        cs = sum(1 for f in files if any(CHANGESETS.match(h) for h in headings(open(os.path.join(rdir, f), encoding="utf8").read())))
        r.update(active=len(active), active_release_notes=len(rn), release_files=len(files), changesets_share=round(cs / len(files), 3) if files else None)
        r["style"] = None if not files else "changesets" if cs / len(files) >= 0.8 else "prose" if cs / len(files) <= 0.2 else "mixed"
        if r.get("eligible") is False:
            out.append(r)
            continue
        if r["repo"] in excluded_repos:
            r.update(eligible=False, why="shares a repository with an excluded technology")
        elif len(rn) < 150:
            r.update(eligible=False, why=f"{len(rn)} active release-notes records < 150")
        elif len(files) < 10:
            r.update(eligible=False, why="fewer than 10 release files")
        elif r["style"] == "mixed":
            r.update(eligible=False, why="mixed style")
        else:
            r.update(eligible=True, rank=H("npm", r["id"]))
        out.append(r)
    el = sorted([r for r in out if r.get("eligible")], key=lambda r: r["rank"])
    order = {s: [r["id"] for r in el if r["style"] == s] for s in ("changesets", "prose")}
    json.dump({"rows": out, "order": order}, open(os.path.join(OUT, "selection-npm.json"), "w"), indent=1)
    for r in out:
        if "name" in r:
            print(r["id"], r.get("active_release_notes"), r.get("style"), r.get("eligible"), r.get("why", ""), r.get("rank", "")[:8])
    print("order", order)


POOL = ["pydantic/pydantic", "pytest-dev/pytest", "encode/httpx", "sqlalchemy/sqlalchemy", "fastapi/fastapi", "encode/starlette",
        "encode/uvicorn", "Textualize/rich", "fastapi/typer", "python-attrs/attrs", "psf/requests", "celery/celery"]
TAG = [re.compile(r"^v?(\d+(?:\.\d+){1,3})$"), re.compile(r"^rel_(\d+)_(\d+)_(\d+)$")]
CONV = {s.lower() for s in ["Major Changes", "Minor Changes", "Patch Changes", "Features", "New Features", "Bug Fixes", "Fixes", "Performance Improvements",
        "Performance", "Reverts", "Breaking Changes", "Breaking", "Deprecations", "Deprecated", "Documentation", "Docs", "Refactor", "Refactoring",
        "Chores", "Miscellaneous", "Tests", "Build System", "Continuous Integration", "Dependencies", "Added", "Changed", "Removed", "Fixed",
        "Security", "Improvements", "Enhancements", "Internal"]}


def norm_heading(h):
    h = re.sub(r"[^\w\s'’]", " ", h)  # emoji and punctuation
    h = re.sub(r"^\s*\d+[\s.]*", "", h)
    return re.sub(r"\s+", " ", h).strip().lower()


def structured(text):
    return any(norm_heading(h) in CONV for h in headings(text))


def version_of(tag):
    for p in TAG:
        m = p.match(tag)
        if m:
            return ".".join(m.groups()) if p is TAG[1] else m.group(1)
    return None


def pypi():
    out = []
    for repo in POOL:
        raw = subprocess.run(["gh", "api", "--paginate", f"repos/{repo}/releases?per_page=100"], capture_output=True, text=True)
        if raw.returncode:
            out.append({"repo": repo, "eligible": False, "why": raw.stderr.strip()[:200]})
            continue
        rels = json.loads(raw.stdout.replace("][", ","))
        keep = []
        for r in rels:
            v = version_of(r["tag_name"])
            if r["draft"] or r["prerelease"] or not v or (r["published_at"] or "")[:10] < "2025-10-15":
                continue
            keep.append({"tag": r["tag_name"], "version": v, "date": r["published_at"][:10], "url": r["html_url"], "body": r["body"] or ""})
        styles = []
        for k in keep:
            hs = headings(k["body"])
            styles.append("generated" if any("what's changed" in h.lower() or "what’s changed" in h.lower() for h in hs) else "sectioned" if structured(k["body"]) else "flat")
        lens = sorted(len(k["body"]) for k in keep)
        med = lens[len(lens) // 2] if lens else 0
        cnt = {s: styles.count(s) for s in ("generated", "sectioned", "flat")}
        style = max(("generated", "sectioned", "flat"), key=lambda s: cnt[s]) if keep else None
        row = {"repo": repo, "releases": len(keep), "median_body": med, "styles": cnt, "style": style, "rank": H("pypi", repo)}
        row["eligible"] = 8 <= len(keep) <= 60 and med >= 300
        if not row["eligible"]:
            row["why"] = f"{len(keep)} releases, median body {med}"
        out.append(row)
        d = os.path.join(OUT, "notes-raw", repo.replace("/", "__"))
        os.makedirs(d, exist_ok=True)
        json.dump(keep, open(os.path.join(d, "releases.json"), "w"), indent=1)
    el = sorted([r for r in out if r["eligible"]], key=lambda r: r["rank"])
    picks = []
    if el:
        picks.append(el[0]["repo"])
        nxt = [r for r in el[1:] if r["style"] != el[0]["style"]]
        if nxt:
            picks.append(nxt[0]["repo"])
    json.dump({"rows": out, "picks": picks}, open(os.path.join(OUT, "selection-pypi.json"), "w"), indent=1)
    for r in sorted(out, key=lambda r: r.get("rank", "")):
        print(r["repo"], r.get("releases"), r.get("median_body"), r.get("styles"), r.get("style"), r["eligible"], r.get("rank", "")[:8])
    print("picks", picks)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    {"npm": npm, "pypi": pypi}[sys.argv[1]]()
