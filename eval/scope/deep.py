"""Deep sample: per package, releases in the last 4 quarters, where its release notes live and their volume in tokens
(chars / 4, as the catalog calibration), maintenance signals (human commits, archived, deprecated, yanked) and how many
admitted packages share its repository (the monorepo / technology unit)."""
import datetime as dt, json, random, re, sys, urllib.parse
import eco, popstats

NOW = dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc)
START = NOW - dt.timedelta(days=365)
Q = [(START + dt.timedelta(days=91.25 * i), START + dt.timedelta(days=91.25 * (i + 1))) for i in range(4)]
BOT = re.compile(r"\[bot\]|dependabot|renovate|github-actions|greenkeeper|snyk-bot|pre-commit-ci|semantic-release", re.I)
STABLE_NPM = re.compile(r"^\d+\.\d+\.\d+$")
PRE_PY = re.compile(r"(a|b|rc|dev|alpha|beta|pre)\d*", re.I)
VER = re.compile(r"(?<![\w.])v?(\d+\.\d+(?:\.\d+)?(?:[-.]?(?:a|b|rc|alpha|beta|dev|post)\.?\d*)?)(?![\w])")
CHANGELOGS = ["CHANGELOG.md", "changelog.md", "CHANGES.md", "HISTORY.md", "CHANGES.rst", "HISTORY.rst", "CHANGELOG.rst",
              "NEWS.md", "docs/changelog.md", "docs/CHANGELOG.md", "docs/changes.rst", "docs/changelog.rst", "RELEASE_NOTES.md"]


def ts(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def quarter(t):
    for i, (a, b) in enumerate(Q):
        if a <= t < b:
            return i
    return None


def registry(eco_name, name):
    """(versions released in window with dates, stable-only flag per version, deprecated, repo, directory)."""
    if eco_name == "npm":
        d = eco.get(f"https://registry.npmjs.org/{name.replace('/', '%2f')}")
        if not d:
            return None
        times = {v: ts(t) for v, t in (d.get("time") or {}).items() if v not in ("created", "modified")}
        latest = (d.get("dist-tags") or {}).get("latest")
        lv = (d.get("versions") or {}).get(latest) or {}
        repo = lv.get("repository") or d.get("repository") or {}
        return {"times": times, "stable": {v: bool(STABLE_NPM.match(v)) for v in times},
                "deprecated": bool(lv.get("deprecated")), "inactive": False, "all_yanked": False,
                "repo_dir": repo.get("directory") if isinstance(repo, dict) else None}
    d = eco.get(f"https://pypi.org/pypi/{name}/json")
    if not d:
        return None
    times, yanked = {}, []
    for v, files in (d.get("releases") or {}).items():
        if files:
            times[v] = min(ts(f["upload_time_iso_8601"]) for f in files)
            yanked.append(all(f.get("yanked") for f in files))
    cls = (d.get("info") or {}).get("classifiers") or []
    return {"times": times, "stable": {v: not PRE_PY.search(v) for v in times}, "deprecated": False,
            "inactive": any("7 - Inactive" in c for c in cls), "all_yanked": bool(yanked) and all(yanked), "repo_dir": None}


def gh_releases(repo):
    out = []
    for page in range(1, 8):
        d = eco.get(f"https://api.github.com/repos/{repo}/releases?per_page=100&page={page}")
        if not d:
            break
        out += d
        if len(d) < 100 or (ts(d[-1].get("published_at") or d[-1].get("created_at")) or NOW) < START:
            break
    return [r for r in out if not r.get("draft") and (ts(r.get("published_at") or r.get("created_at")) or START) >= START]


def short(name):
    return name.split("/")[-1].lower()


def norm(s):
    return re.sub(r"[-_.]", "", s.lower())


def releases_for(pkg, rels, versions):
    """Releases of a repository that carry this package's versions in the window. When the repository tags per package
    (a tag names some package), only tags naming this one count; otherwise the stream is shared by every package the
    repository publishes, and its notes are counted once per repository (dedupe by multiplicity)."""
    s = norm(short(pkg))
    vers = {v for v in versions}
    def has_version(tag):
        return any(re.search(rf"(?<![\d.]){re.escape(v)}(?![\d])", tag) for v in vers)
    full = norm(pkg)

    def prefix(tag):
        m = re.search(r"v?\d+\.\d+", tag)
        return norm(re.sub(r"[@/_\-v]+$", "", tag[: m.start()] if m else tag).split("/")[-1]) if tag else ""
    named = [r for r in rels if prefix(r.get("tag_name") or "") in (s, full)]
    if named:
        return [r for r in named if has_version(r.get("tag_name") or "")], True
    per_pkg_repo = sum(1 for r in rels if re.search(r"[@/_]|[a-z]-v?\d", r.get("tag_name") or "", re.I)) > len(rels) // 2
    if per_pkg_repo:  # the main package may keep plain version tags
        return [r for r in rels if prefix(r.get("tag_name") or "") == "" and has_version(r.get("tag_name") or "")], True
    return [r for r in rels if has_version(r.get("tag_name") or "")], False


def changelog_tokens(repo, branch, wanted, directory=None):
    paths = ([f"{directory}/{p}" for p in CHANGELOGS[:4]] if directory else []) + CHANGELOGS
    for p in paths:
        txt = eco.get(f"https://raw.githubusercontent.com/{repo}/{branch}/{p}", kind="text")
        if not txt or txt.startswith("404: Not Found"):
            continue
        sections, cur, buf = {}, None, []
        for line in txt.splitlines():
            m = VER.search(line) if (line.startswith("#") or re.match(r"^\s*\[?v?\d+\.\d+", line) or line.startswith("Version") or line.startswith("v")) and len(line) < 120 else None
            if m:
                if cur:
                    sections[cur] = sections.get(cur, 0) + sum(len(b) + 1 for b in buf)
                cur, buf = m.group(1).lstrip("v"), []
            elif cur:
                buf.append(line)
        if cur:
            sections[cur] = sections.get(cur, 0) + sum(len(b) + 1 for b in buf)
        hit = {v: c for v, c in sections.items() if v in wanted}
        return p, {v: c / 4 for v, c in hit.items()}, len(txt) / 4
    return None, {}, 0


def human_commits(repo):
    since = START.strftime("%Y-%m-%dT%H:%M:%SZ")
    d = eco.get(f"https://api.github.com/repos/{repo}/commits?since={since}&per_page=100") or []
    names = [((c.get("author") or {}).get("login") or (c.get("commit") or {}).get("author", {}).get("name") or "") for c in d]
    return len(d), sum(1 for n in names if not BOT.search(n))


def repo_multiplicity(eco_name, repo_url):
    """Admitted packages (current rule) published from the same repository."""
    if not repo_url:
        return 1
    reg = {"npm": "npmjs.org", "pypi": "pypi.org"}[eco_name]
    d = eco.get(f"https://packages.ecosyste.ms/api/v1/packages/lookup?repository_url={urllib.parse.quote(repo_url, safe='')}") or []
    import pop
    same = [x for x in d if (x.get("registry") or {}).get("name", reg) == reg or x.get("ecosystem") == eco_name]
    adm = [x for x in same if popstats.current(pop.signals(x))]
    return max(1, len(adm))


def measure(eco_name, p):
    name = p["name"]
    reg = registry(eco_name, name)
    row = {"eco": eco_name, "name": name, "band": p.get("band"), "weight": p.get("weight", 1.0), "repo": p["repo"],
           "stars": p["stars"], "archived": p["archived"], "fork": p["fork"], "status": p["status"],
           "dep_repos": p["dep_repos"], "dep_pkgs": p["dep_pkgs"], "downloads_month": p["downloads_month"], "types": p["types"]}
    if not reg:
        row["error"] = "registry"
        return row
    win = {v: t for v, t in reg["times"].items() if t and t >= START}
    stable = {v for v in win if reg["stable"].get(v)}
    row.update(releases=len(win), stable_releases=len(stable), per_q=[sum(1 for t in win.values() if quarter(t) == i) for i in range(4)],
               deprecated=reg["deprecated"], inactive=reg["inactive"], all_yanked=reg["all_yanked"],
               last_release_days=min([(NOW - t).days for t in reg["times"].values() if t] or [None]) if reg["times"] else None)
    repo = p["repo"] if "/" in (p["repo"] or "") and not p["repo"].startswith("http") else None
    if repo:
        meta = eco.get(f"https://api.github.com/repos/{repo}") or {}
        branch = meta.get("default_branch") or "main"
        rels = gh_releases(repo)
        mine, row["per_package_tags"] = releases_for(name, rels, set(win))
        row["repo_releases"] = len(rels)
        tok_rel = sum(len(r.get("body") or "") for r in mine) / 4
        src, tok_cl, _ = (None, {}, 0)
        if tok_rel < 50 * max(1, len(stable)):  # no or empty GitHub releases: try a changelog file
            src, tok_cl, _ = changelog_tokens(repo, branch, set(win), reg.get("repo_dir"))
        cl = sum(tok_cl.values())
        row.update(gh_releases=len(mine), gh_tokens=round(tok_rel), changelog=src, changelog_tokens=round(cl),
                   notes_tokens=round(max(tok_rel, cl)),
                   notes_source="github_releases" if tok_rel >= cl and tok_rel > 0 else ("changelog" if cl > 0 else "none"))
        row["commits"], row["human_commits"] = human_commits(repo)
        row["multiplicity"] = repo_multiplicity(eco_name, f"https://github.com/{repo}")
    else:
        row.update(notes_tokens=0, notes_source="no repo", multiplicity=1)
    return row


if __name__ == "__main__":
    P = json.load(open("pop.json"))
    rng = random.Random(1610)
    per_band = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    picks = []
    for band, b in P.items():
        eco_name = band.split()[0]
        if " b0 " in band:  # b0 admitted packages are all stars-only; b-1 covers the same path
            pass
        adm = [x for x in b["packages"] if popstats.current(x)]
        k = min(per_band, len(adm))
        for x in rng.sample(adm, k):
            est_admitted = b["population"] * len(adm) / len(b["packages"])
            picks.append((eco_name, {**x, "band": band, "weight": est_admitted / k}))
    rows = []
    for i, (e, x) in enumerate(picks):
        try:
            rows.append(measure(e, x))
        except Exception as ex:
            rows.append({"eco": e, "name": x["name"], "band": x["band"], "weight": x["weight"], "error": repr(ex)})
        print(i, e, x["name"], rows[-1].get("notes_source"), rows[-1].get("notes_tokens"), rows[-1].get("stable_releases"), flush=True)
    json.dump(rows, open("deep.json", "w"), indent=0)
