"""A representative, pinned subset of the census for runs that cost per repository (coverage timing, latency, QA).

    python3 -I select.py [--per-cell 3]

Strata: primary ecosystem (the first of npm, PyPI, Go, crates.io, Maven/Gradle, other, in census order of share)
by size (GitHub repository size, terciles over the census). Within a cell, repositories are taken in sha256 order of
their name (deterministic, not search rank). Each is pinned to its default branch's current commit. Writes set.json.
"""
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PRIMARY = ["npm", "PyPI", "Go modules", "crates.io", "Maven/Gradle"]
ALIAS = {"Go": "Go modules"}


def gh(path, jq):
    p = subprocess.run(["gh", "api", path, "--jq", jq], capture_output=True, text=True)
    return p.stdout.strip() if p.returncode == 0 else None


def main():
    per = int(sys.argv[sys.argv.index("--per-cell") + 1]) if "--per-cell" in sys.argv else 3
    census = json.load(open(os.path.join(HERE, "census.json")))
    rows = []
    for repo, ecos in census.items():
        if not ecos:
            continue
        ecos = [ALIAS.get(e, e) for e in ecos]
        primary = next((e for e in PRIMARY if e in ecos), "other")
        meta = gh(f"repos/{repo}", "[.size, .default_branch, .stargazers_count, .archived] | @json")
        if not meta:
            continue
        size, branch, stars, archived = json.loads(meta)
        if archived:
            continue
        rows.append(dict(repo=repo, ecosystems=ecos, primary=primary, size_kb=size, stars=stars, branch=branch))
    sizes = sorted(r["size_kb"] for r in rows)
    t1, t2 = sizes[len(sizes) // 3], sizes[2 * len(sizes) // 3]
    for r in rows:
        r["size"] = "small" if r["size_kb"] < t1 else "medium" if r["size_kb"] < t2 else "large"
    chosen = []
    for eco in PRIMARY + ["other"]:
        for size in ("small", "medium", "large"):
            cell = sorted((r for r in rows if r["primary"] == eco and r["size"] == size), key=lambda r: hashlib.sha256(r["repo"].encode()).hexdigest())
            for r in cell[:per]:
                sha = gh(f"repos/{r['repo']}/commits/{r['branch']}", ".sha")
                if sha:
                    chosen.append(dict(r, sha=sha))
    out = dict(source="census.json", size_terciles_kb=[t1, t2], per_cell=per, repos=chosen)
    json.dump(out, open(os.path.join(HERE, "set.json"), "w"), indent=1)
    cells = {}
    for r in chosen:
        cells.setdefault(r["primary"], {}).setdefault(r["size"], 0)
        cells[r["primary"]][r["size"]] += 1
    print(f"{len(chosen)} repositories; size terciles {t1} / {t2} KB")
    for eco, c in cells.items():
        print(f"  {eco:13s} " + "  ".join(f"{s} {c.get(s, 0)}" for s in ("small", "medium", "large")))


if __name__ == "__main__":
    main()
