"""Platform stratum (runtimes, languages, package managers): release-note volume over the last 4 quarters from GitHub
releases; CPython from its changelog page (no GitHub releases)."""
import json, re, html
import eco, deep

PLATFORMS = {"Node.js": "nodejs/node", "TypeScript": "microsoft/TypeScript", "Deno": "denoland/deno", "Bun": "oven-sh/bun",
             "pnpm": "pnpm/pnpm", "npm CLI": "npm/cli", "Yarn": "yarnpkg/berry", "pip": "pypa/pip", "uv": "astral-sh/uv",
             "Poetry": "python-poetry/poetry", "setuptools": "pypa/setuptools"}

if __name__ == "__main__":
    rows = []
    for name, repo in PLATFORMS.items():
        rels = deep.gh_releases(repo)
        stable = [r for r in rels if not r.get("prerelease")]
        tok = sum(len(r.get("body") or "") for r in stable) / 4
        per_q = [sum(1 for r in stable if deep.quarter(deep.ts(r.get("published_at"))) == i) for i in range(4)]
        src = "github_releases"
        if tok < 200:
            br = (eco.get(f"https://api.github.com/repos/{repo}") or {}).get("default_branch", "main")
            wanted = {re.sub(r"^v", "", r.get("tag_name") or "") for r in rels}
            p, cl, _ = deep.changelog_tokens(repo, br, wanted)
            if sum(cl.values()) > tok:
                tok, src = sum(cl.values()), f"changelog {p}"
        rows.append({"name": name, "repo": repo, "stable_releases": len(stable), "per_q": per_q, "notes_tokens": round(tok), "notes_source": src})
        print(rows[-1], flush=True)
    # CPython: docs changelog for the versions released in the window (3.13.x, 3.14.x, 3.15 alphas excluded).
    page = eco.get("https://docs.python.org/3/whatsnew/changelog.html", kind="text") or ""
    text = html.unescape(re.sub(r"<[^>]+>", "", page))
    parts = re.split(r"\n(Python \d+\.\d+\.\d+(?:\w+\d*)? final)\n", text)
    secs = {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}
    dated = {}
    for k, v in secs.items():
        m = re.search(r"Release date: (\d{4}-\d{2}-\d{2})", v)
        if m and m.group(1) >= deep.START.strftime("%Y-%m-%d"):
            dated[k] = len(v) / 4
    rows.append({"name": "CPython", "repo": "python/cpython", "stable_releases": len(dated), "notes_tokens": round(sum(dated.values())),
                 "notes_source": "docs changelog (current branch only)", "versions": sorted(dated)})
    print(rows[-1])
    json.dump(rows, open("platform.json", "w"), indent=1)
