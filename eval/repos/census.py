"""Ecosystem census of public repositories that use coding agents (an `AGENTS.md` or `CLAUDE.md` file).

    gh search code --filename AGENTS.md --limit 100 ...; gh search code --filename CLAUDE.md ... > census-repos.txt
    python3 -I census.py

One `git/trees/HEAD?recursive=1` call per repository; manifests under node_modules, vendor, examples, tests,
fixtures, docs and third_party are not counted. Writes census.json (repository -> ecosystems).
"""
import json, os, subprocess, sys, collections, concurrent.futures as cf
HERE = os.path.dirname(os.path.abspath(__file__))
MAN = {"package.json":"npm","pyproject.toml":"PyPI","requirements.txt":"PyPI","Pipfile":"PyPI","setup.py":"PyPI","go.mod":"Go","pom.xml":"Maven/Gradle","build.gradle":"Maven/Gradle","build.gradle.kts":"Maven/Gradle","composer.json":"Composer","Gemfile":"RubyGems","Cargo.toml":"crates.io","mix.exs":"Hex","Package.swift":"SwiftPM","pubspec.yaml":"pub"}
SKIP = ("node_modules/","vendor/","examples/","example/","test/","tests/","fixtures/","docs/","third_party/")
def eco(path):
    base = path.rsplit("/",1)[-1]
    if base.endswith(".csproj") or base.endswith(".fsproj"): return "NuGet"
    if base.startswith("requirements") and base.endswith(".txt"): return "PyPI"
    return MAN.get(base)
def repo(r):
    p = subprocess.run(["gh","api",f"repos/{r}/git/trees/HEAD?recursive=1","--jq",".tree[].path"],capture_output=True,text=True)
    if p.returncode: return r, None
    ecos = set()
    for path in p.stdout.split("\n"):
        if any(s in "/"+path for s in ["/"+x for x in SKIP]): continue
        e = eco(path)
        if e: ecos.add(e)
    return r, sorted(ecos)
repos = [l.strip() for l in open(os.path.join(HERE, "census-repos.txt")) if l.strip()]
out = {}
with cf.ThreadPoolExecutor(8) as ex:
    for r, e in ex.map(repo, repos): out[r] = e
json.dump(out, open(os.path.join(HERE, "census.json"),"w"), indent=1)
ok = {r:e for r,e in out.items() if e is not None}
c = collections.Counter(x for e in ok.values() for x in e)
n = len(ok)
print(f"repos read {n} of {len(repos)}; with no recognised manifest: {sum(1 for e in ok.values() if not e)}")
for k,v in c.most_common(): print(f"{k:14s} {v:4d}  {100*v/n:5.1f}%")
print("npm-only", sum(1 for e in ok.values() if e==['npm']), " covered by npm+PyPI entirely", sum(1 for e in ok.values() if e and set(e)<= {'npm','PyPI'}))
