"""Technology selection for the majors held-out set (PREREG.md sections 1-2). Reads registry metadata, repository file
paths and sizes, and heading lines; document bodies are read only for their length and heading lines. Writes
eval/select/out/holdout-majors/{exclusion,selection}.json and prints the candidate table.

    python3 -I select_majors.py [--reserve]
"""
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from majors_lib import H, OUT, ROOT, WINDOW, gh, headings, http_get, raw, release_clean, repo_head, section, tree, version_re  # noqa: E402

MIN_CHARS = 3000

# (package, code repo, docs repo or None for the code repo, calver)
NPM = [
    ("vite", "vitejs/vite", None), ("vitest", "vitest-dev/vitest", None), ("eslint", "eslint/eslint", None),
    ("typescript", "microsoft/TypeScript", "microsoft/TypeScript-Website"), ("storybook", "storybookjs/storybook", None),
    ("mongoose", "Automattic/mongoose", None), ("astro", "withastro/astro", "withastro/docs"),
    ("@angular/core", "angular/angular", None), ("react-router", "remix-run/react-router", None),
    ("svelte", "sveltejs/svelte", None), ("@sveltejs/kit", "sveltejs/kit", None),
    ("tailwindcss", "tailwindlabs/tailwindcss", "tailwindlabs/tailwindcss.com"),
    ("express", "expressjs/express", "expressjs/expressjs.com"), ("nx", "nrwl/nx", None), ("pnpm", "pnpm/pnpm", "pnpm/pnpm.io"),
    ("ai", "vercel/ai", None), ("@tanstack/react-query", "TanStack/query", None),
    ("drizzle-orm", "drizzle-team/drizzle-orm", "drizzle-team/drizzle-orm-docs"), ("typeorm", "typeorm/typeorm", None),
    ("msw", "mswjs/msw", "mswjs/mswjs.io"), ("webpack", "webpack/webpack", "webpack/webpack.js.org"),
    ("electron", "electron/electron", None), ("jest", "jestjs/jest", None), ("prettier", "prettier/prettier", None),
    ("uuid", "uuidjs/uuid", None),
]
PYPI = [
    ("pytest", "pytest-dev/pytest", None), ("django", "django/django", None), ("pandas", "pandas-dev/pandas", None),
    ("langchain", "langchain-ai/langchain", "langchain-ai/docs"), ("transformers", "huggingface/transformers", None),
    ("huggingface-hub", "huggingface/huggingface_hub", None), ("pillow", "python-pillow/Pillow", None),
    ("redis", "redis/redis-py", None), ("websockets", "python-websockets/websockets", None),
    ("sqlalchemy", "sqlalchemy/sqlalchemy", None), ("pydantic", "pydantic/pydantic", None), ("httpx", "encode/httpx", None),
    ("starlette", "encode/starlette", None), ("celery", "celery/celery", None), ("black", "psf/black", None),
    ("ruff", "astral-sh/ruff", None), ("mypy", "python/mypy", None), ("aiohttp", "aio-libs/aiohttp", None),
    ("psycopg", "psycopg/psycopg", None), ("sphinx", "sphinx-doc/sphinx", None), ("setuptools", "pypa/setuptools", None),
    ("openai", "openai/openai-python", None), ("numpy", "numpy/numpy", None),
    ("marshmallow", "marshmallow-code/marshmallow", None), ("flask", "pallets/flask", None),
]
CALVER = {"black"}
RESERVE_NPM = [("mocha", "mochajs/mocha", None), ("chai", "chaijs/chai", None), ("yargs", "yargs/yargs", None),
               ("commander", "tj/commander.js", None), ("sequelize", "sequelize/sequelize", None), ("koa", "koajs/koa", None),
               ("three", "mrdoob/three.js", None), ("undici", "nodejs/undici", None)]
RESERVE_PYPI = [("scikit-learn", "scikit-learn/scikit-learn", None), ("matplotlib", "matplotlib/matplotlib", None),
                ("polars", "pola-rs/polars", None), ("apache-airflow", "apache/airflow", None), ("alembic", "sqlalchemy/alembic", None),
                ("jinja2", "pallets/jinja", None), ("click", "pallets/click", None), ("werkzeug", "pallets/werkzeug", None)]
NAMED = {"next", "prisma", "nestjs", "nuxt", "laravel", "node", "fastify", "posthog-js", "zod", "uvicorn", "typer"}

# ---------------------------------------------------------------- 2.1 exclusion


def eval_corpus():
    out = []
    ev = os.path.join(ROOT, "eval")
    extra = [os.path.join(ev, "select", "splits.json"), os.path.join(ev, "select", "holdout", "technologies.json")]
    paths = []
    for dp, dn, fn in os.walk(ev):
        rel = os.path.relpath(dp, ROOT)
        if rel == "eval/select" or rel.startswith("eval/select/") or "node_modules" in rel or "__pycache__" in rel:
            dn[:] = []
            continue
        paths += [os.path.join(dp, f) for f in fn]
    for p in paths + extra:
        if p.endswith(".gz"):
            continue
        with open(p, "rb") as fh:
            b = fh.read()
        if b"\0" in b[:8192]:
            continue
        out.append((os.path.relpath(p, ROOT), b.decode("utf8", errors="ignore").lower()))
    return out


def word(term):
    return re.compile(r"(?<![a-z0-9_\-.])" + re.escape(term.lower()) + r"(?![a-z0-9_\-]|\.[a-z0-9])")


def terms_for(pkg, repo, eco):
    bare = pkg.split("/")[-1]
    t = [repo.lower()]
    for n in dict.fromkeys([pkg, bare]):
        t += [f"pkg:npm/{n.lower()}", f"pkg:pypi/{n.lower()}"] if len(n) < 4 else [n.lower()]
    return t


def exclusion(cands, corpus):
    hits = {}
    for pkg, repo, _docs, eco in cands:
        if pkg in NAMED or pkg.split("/")[-1] in NAMED:
            hits[pkg] = [["(named in the brief)", pkg]]
            continue
        hs = []
        for term in terms_for(pkg, repo, eco):
            rx = word(term)
            hs += [[p, term] for p, txt in corpus if rx.search(txt)]
        hits[pkg] = hs
    repos_out = {repo.lower() for pkg, repo, _d, _e in cands if hits[pkg]}
    for pkg, repo, _d, _e in cands:
        if not hits[pkg] and repo.lower() in repos_out:
            hits[pkg] = [["(shares a repository with an excluded candidate)", repo]]
    return hits

# ---------------------------------------------------------------- 2.2-2.3 the major


def vt(v):
    return tuple(int(x) for x in v.split("."))


def registry(pkg, eco):
    """{version: date} of stable versions."""
    if eco == "npm":
        s, txt = http_get("https://registry.npmjs.org/" + pkg.replace("/", "%2F"))
        d = json.loads(txt) if s == 200 else {}
        tm = d.get("time", {})
        return {v: tm[v][:10] for v in d.get("versions", {}) if re.fullmatch(r"\d+\.\d+\.\d+", v) and v in tm}
    s, txt = http_get(f"https://pypi.org/pypi/{pkg}/json")
    d = json.loads(txt) if s == 200 else {}
    out = {}
    for v, files in d.get("releases", {}).items():
        if not re.fullmatch(r"\d+(\.\d+){1,3}", v) or not files or all(f.get("yanked") for f in files):
            continue
        out[v] = min(f["upload_time_iso_8601"] for f in files)[:10]
    return out


def is_x00(v, eco):
    p = v.split(".")
    return int(p[0]) >= 1 and all(x == "0" for x in p[1:]) and (len(p) == 3 or (eco == "pypi" and len(p) == 2))


def semver_major(vers, eco):
    """Latest in-window X.0.0 that opens a new major line."""
    best = None
    for v, d in vers.items():
        if not is_x00(v, eco) or d < WINDOW:
            continue
        x = vt(v)[0]
        earlier = [vt(u)[0] for u, du in vers.items() if du < d]
        if earlier and max(earlier) >= x:
            continue
        if best is None or vt(v) > vt(best):
            best = v
    return best


def zero_candidates(vers, calver):
    out = []
    for v, d in vers.items():
        p = vt(v)
        if d < WINDOW:
            continue
        if calver:
            if len(p) >= 2 and p[1] == 1 and all(x == 0 for x in p[2:]):
                out.append(v)
        elif p[0] == 0 and len(p) >= 2 and all(x == 0 for x in p[2:]):
            out.append(v)
    return sorted(out, key=vt, reverse=True)


def forms(v, eco):
    p = v.split(".")
    s = {v}
    if eco == "pypi":
        s |= {".".join(p[:2]), ".".join(p[:2]) + ".0"} if len(p) <= 3 and all(x == "0" for x in p[2:]) else set()
    return sorted(s, key=len, reverse=True)

# ---------------------------------------------------------------- 2.4 documents

LANGS = {"zh", "zh-cn", "zh-hans", "zh-hant", "zh-tw", "zh_cn", "zh_tw", "ja", "ja-jp", "ko", "ko-kr", "ru", "fr", "de", "es",
         "pt", "pt-br", "pt_br", "it", "tr", "uk", "pl", "vi", "id", "ar", "fa", "he", "hi", "nl", "cs", "sv", "th", "ro", "hu",
         "bn", "ca", "el", "fi", "no", "nb", "da", "sk", "sl", "sr", "bg", "lt", "lv", "et", "ms", "ta", "te", "ur", "kr", "cn", "jp"}
SKIP_SEG = {"i18n", "translations", "locales", "locale", "test", "tests", "__tests__", "fixtures", "fixture", "__fixtures__",
            "node_modules", "blog", "versioned_docs", "versioned_sidebars", "archive", "archived", "testdata", "e2e"}
DOC_EXT = re.compile(r"\.(md|mdx|markdown|rst|txt)$", re.I)
CHANGELOG = re.compile(r"(^|/)(CHANGELOG|CHANGES|HISTORY|NEWS)[^/]*\.(md|rst|txt)$", re.I)


def skip_path(path, x=None):
    segs = path.split("/")[:-1]
    for s in segs:
        sl = s.lower()
        if sl in SKIP_SEG or sl in LANGS or re.search(r"(^|[-_])(test|tests|fixtures?)($|[-_])", sl):
            return True
        m = re.fullmatch(r"v?(\d+)(\.\d+)*(\.x)?", sl)
        if x is not None and m and int(m.group(1)) < x:
            return True
    return False


def release_notes(pkg, repo, eco, v):
    bare = pkg.split("/")[-1]
    names = [pkg] + ([bare] if bare != pkg else [])
    tags = []
    for V in forms(v, eco):
        tags += [f"v{V}", V]
    for n in names:
        for V in forms(v, eco):
            tags += [f"{n}@{V}", f"{n}=={V}", f"{n}-v{V}", f"{n}-{V}", f"{n}/v{V}"]
    for tag in dict.fromkeys(tags):
        s, r = gh(f"repos/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}")
        if s == 200 and not r.get("draft"):
            body = release_clean((r.get("body") or "").replace("\r\n", "\n"))
            return {"style": "github_release", "chars": len(body), "text": body, "url": r["html_url"],
                    "source": {"repo": repo, "release_id": r["id"], "tag": tag}}
    return None


def changelog_section(pkg, repo, eco, v, files, sha):
    bare = pkg.split("/")[-1]
    cands = [p for p, _ in files if CHANGELOG.search(p) and not skip_path(p)]
    def rank(p):
        d = p.split("/")[:-1]
        own = bool(d) and d[-1].lower() in (bare.lower(), pkg.replace("@", "").replace("/", "-").lower())
        return (0 if own else 1 if not d else 2, len(d), p)
    rx = version_re(forms(v, eco))
    for p in sorted(cands, key=rank)[:12]:
        txt = raw(repo, sha, p)
        if not txt:
            continue
        txt = txt.replace("\r\n", "\n")
        for ln, lv, title in headings(txt):
            if rx.search(title):
                sec = section(txt, ln)
                return {"style": "changelog_section", "chars": len(sec), "text": sec,
                        "url": f"https://github.com/{repo}/blob/{sha}/{p}", "source": {"repo": repo, "sha": sha, "path": p, "heading": title}}
    return None


def docs_page(eco, v, docs_repo, dfiles, dsha):
    fs = forms(v, eco)
    for p, size in sorted(dfiles, key=lambda e: e[0]):
        if not DOC_EXT.search(p) or skip_path(p) or not re.search(r"(release|whatsnew|changelog|news)", p, re.I):
            continue
        stem = re.sub(DOC_EXT, "", p.split("/")[-1]).lower()
        stem = re.sub(r"^(v|version-|release-|releasenotes-)", "", stem)
        if stem in fs:
            txt = (raw(docs_repo, dsha, p) or "").replace("\r\n", "\n")
            return {"style": "docs_page", "chars": len(txt), "text": txt,
                    "url": f"https://github.com/{docs_repo}/blob/{dsha}/{p}", "source": {"repo": docs_repo, "sha": dsha, "path": p}}
    return None


def notes_doc(pkg, repo, eco, v, files, sha, docs_repo, dfiles, dsha):
    for f in (lambda: release_notes(pkg, repo, eco, v), lambda: changelog_section(pkg, repo, eco, v, files, sha),
              lambda: docs_page(eco, v, docs_repo, dfiles, dsha)):
        d = f()
        if d and d["chars"] >= MIN_CHARS:
            return d
    return None


def major_token(x):
    """x: the major as a string ("9"), or "0.Y" for a 0.x release."""
    return re.compile(r"(?<![0-9.])(?:v|version[-_ ]?)?%s(?:\.0(?:\.0)?|\.x)?(?![0-9])" % re.escape(x), re.I)


def target_names_major(title, x):
    tok = major_token(x)
    m = re.split(r"\bto\b|→|->", title, flags=re.I)
    if len(m) > 1:
        return bool(re.match(r"\s*(?:v|version\s*)?%s(?:\.0(?:\.0)?|\.x)?(?![0-9])" % re.escape(x), m[-1].strip(), re.I))
    e = re.escape(x)
    return bool(re.search(r"(?<![0-9.])(?:v%s|%s\.0|%s\.x)(?![0-9])" % (e, e, e), title, re.I))


def guide_doc(x, docs_repo, dfiles, dsha):
    tok = major_token(x)
    pool = [(p, s) for p, s in dfiles if DOC_EXT.search(p) and re.search(r"(upgrad|migrat)", p, re.I) and not skip_path(p, int(x.split(".")[0]))]
    named = []
    for p, s in pool:
        parts = p.split("/")
        stem = re.sub(DOC_EXT, "", parts[-1])
        parent = parts[-2] if len(parts) > 1 else ""
        if tok.search(stem) or tok.search(parent):
            named.append((p, s))
    for p, s in sorted(named, key=lambda e: -e[1]):
        txt = (raw(docs_repo, dsha, p) or "").replace("\r\n", "\n")
        if len(txt) >= MIN_CHARS:
            return {"mode": "file", "chars": len(txt), "text": txt, "url": f"https://github.com/{docs_repo}/blob/{dsha}/{p}",
                    "source": {"repo": docs_repo, "sha": dsha, "path": p}}
        return None  # the chosen (largest) named file is too short: no guide (PREREG 2.4)
    best = None
    for p, s in sorted(pool, key=lambda e: (-e[1], e[0]))[:40]:
        if s > 3_000_000:
            continue
        txt = (raw(docs_repo, dsha, p) or "").replace("\r\n", "\n")
        for ln, lv, title in headings(txt):
            if target_names_major(title, x):
                sec = section(txt, ln)
                if best is None or len(sec) > best["chars"]:
                    best = {"mode": "section", "chars": len(sec), "text": sec, "url": f"https://github.com/{docs_repo}/blob/{dsha}/{p}",
                            "source": {"repo": docs_repo, "sha": dsha, "path": p, "heading": title}}
                break
    return best if best and best["chars"] >= MIN_CHARS else None

# ---------------------------------------------------------------- evaluation and pick


def evaluate(pkg, repo, docs_repo, eco, excluded):
    row = {"package": pkg, "ecosystem": eco, "repo": repo, "docs_repo": docs_repo or repo, "hash": H(eco, pkg)}
    if excluded:
        row.update(eligible=False, why="excluded", exclusion=excluded[:5])
        return row
    vers = registry(pkg, eco)
    if not vers:
        row.update(eligible=False, why="no registry data")
        return row
    latest = max(vers, key=vt)
    row["latest"] = latest
    br, sha = repo_head(repo)
    files, trunc = tree(repo, sha) if sha else ([], False)
    dr = docs_repo or repo
    dbr, dsha = (br, sha) if dr == repo else repo_head(dr)
    dfiles, dtrunc = (files, trunc) if dr == repo else (tree(dr, dsha) if dsha else ([], False))
    row.update(code_sha=sha, docs_sha=dsha, tree_truncated=trunc or dtrunc)
    major, notes, rule = semver_major(vers, eco), None, "2.2"
    if major:
        notes = notes_doc(pkg, repo, eco, major, files, sha, dr, dfiles, dsha)
    elif vt(latest)[0] == 0 or pkg in CALVER:
        rule = "2.3"
        for v in zero_candidates(vers, pkg in CALVER):
            n = notes_doc(pkg, repo, eco, v, files, sha, dr, dfiles, dsha)
            if n and any(re.search(r"breaking", t, re.I) for _, _, t in headings(n["text"])) and any(
                    re.search(r"migrat|upgrad", t, re.I) for _, _, t in headings(n["text"])):
                major, notes = v, n
                break
    if not major:
        row.update(eligible=False, why="no in-window major (rule %s)" % rule)
        return row
    p = vt(major)
    label = str(p[0]) if p[0] > 0 else "0.%d" % p[1]
    guide = guide_doc(label, dr, dfiles, dsha)
    row.update(major=major, date=vers[major], rule=rule,
               notes=None if not notes else {k: v for k, v in notes.items() if k != "text"},
               guide=None if not guide else {k: v for k, v in guide.items() if k != "text"})
    row["style"] = {"notes": notes["style"] if notes else "none", "guide": bool(guide)}
    row["eligible"] = bool(notes or guide)
    row["why"] = "eligible" if row["eligible"] else "no document of %d+ characters" % MIN_CHARS
    return row


def pick(rows):
    """rows in evaluation order (the main pool in hash order, then the reserve pool in hash order)."""
    el = [r for r in rows if r["eligible"]]
    if not el:
        return []
    first = next((r for r in el if r["style"]["guide"]), el[0])
    after = el[el.index(first) + 1:]
    second = next((r for r in after if r["style"]["notes"] != first["style"]["notes"]), after[0] if after else None)
    return [first] + ([second] if second else [])


def main():
    os.makedirs(OUT, exist_ok=True)
    corpus = eval_corpus()
    pools = {"npm": NPM + RESERVE_NPM, "pypi": PYPI + RESERVE_PYPI}
    allc = [(p, r, d, eco) for eco, lst in pools.items() for p, r, d in lst]
    hits = exclusion(allc, corpus)
    with open(os.path.join(OUT, "exclusion.json"), "w") as fh:
        json.dump({"corpus_files": len(corpus), "hits": hits}, fh, indent=1)
    result = {"seed": "unstale-majors-v1", "window": WINDOW, "ecosystems": {}}
    for eco, main_pool, reserve in (("npm", NPM, RESERVE_NPM), ("pypi", PYPI, RESERVE_PYPI)):
        rows = [evaluate(p, r, d, eco, hits[p]) for p, r, d in sorted(main_pool, key=lambda e: H(eco, e[0]))]
        picks = pick(rows)
        used_reserve = False
        if len(picks) < 2:
            used_reserve = True
            rows += [evaluate(p, r, d, eco, hits[p]) for p, r, d in sorted(reserve, key=lambda e: H(eco, e[0]))]
            picks = pick(rows)
        result["ecosystems"][eco] = {"rows": rows, "picks": [r["package"] for r in picks], "used_reserve": used_reserve}
        print(f"== {eco}: picks {[r['package'] for r in picks]}{' (reserve used)' if used_reserve else ''}")
        for r in rows:
            n, g = r.get("notes") or {}, r.get("guide") or {}
            print("  %-22s %s  %-38s major %-9s %s  notes %-18s %6s  guide %-8s %6s%s" % (
                r["package"], r["hash"][:8], r["why"][:38], r.get("major", "-"), r.get("date", "-"),
                n.get("style", "-"), n.get("chars", ""), g.get("mode", "-"), g.get("chars", ""), "  TRUNCATED TREE" if r.get("tree_truncated") else ""))
    with open(os.path.join(OUT, "selection.json"), "w") as fh:
        json.dump(result, fh, indent=1)


if __name__ == "__main__":
    main()
