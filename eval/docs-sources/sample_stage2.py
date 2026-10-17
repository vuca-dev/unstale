"""D1 stage 2 sample: distinct packages declared directly by recently active public
repositories, the population lazy registration meets. Rule fixed before drawing:

- Repositories: GitHub repository search `stars:50..5000 pushed:>=2026-04-15 fork:false archived:false
  language:<L>`, sorted by stars, first 100 results per language; TypeScript, Python, Rust. Excluded: templates,
  names or descriptions with template/starter/boilerplate/example/demo/tutorial/awesome, and every evaluation
  repository (eval/replay/events/EVENTS.md). Take 12 TypeScript, 6 Python and 4 Rust repositories by sha256 of
  the full name.
- Manifests at the default branch root only: package.json (dependencies, devDependencies, peerDependencies),
  pyproject.toml ([project] dependencies, Poetry dependencies), Cargo.toml ([dependencies], [dev-dependencies]).
  Workspace, path, git and private entries are skipped.
- Packages: distinct package URLs over all manifests, minus the stage-1 sample; 40 drawn by sha256 of the package URL
  (uniform over distinct technologies, since registration admits each once).

  python3 -I eval/docs-sources/sample_stage2.py eval/docs-sources/sample-stage2.json          # stage 2: pool[0:40]
  python3 -I eval/docs-sources/sample_stage2.py eval/docs-sources/sample-stage3.json 40 20    # stage 3: pool[40:60],
      drawn after stages 1 and 2 were used for tuning, as the out-of-sample check
"""
import base64, hashlib, json, re, subprocess, sys, tomllib

H = lambda s: hashlib.sha256(s.encode()).hexdigest()
EXCLUDE_WORDS = re.compile(r"template|starter|boilerplate|example|demo|tutorial|awesome", re.I)


def gh(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 else None


def eval_repos():
    text = open("eval/replay/events/EVENTS.md").read()
    return {m.lower() for m in re.findall(r"^- ([\w.-]+/[\w.-]+)$", text, re.M)}


def repos(lang, n):
    found = []
    for page in (1, 2):
        q = f"stars:50..5000 pushed:>=2026-04-15 fork:false archived:false language:{lang}"
        res = gh(f"search/repositories?q={q.replace(' ', '+')}&sort=stars&order=desc&per_page=50&page={page}") or {}
        found += res.get("items", [])
    ex = eval_repos()
    ok = [r for r in found if not r.get("is_template") and r["full_name"].lower() not in ex
          and not EXCLUDE_WORDS.search(r["full_name"] + " " + (r.get("description") or ""))]
    return sorted(ok, key=lambda r: H(r["full_name"]))[:n]


def file(full, branch, path):
    r = gh(f"repos/{full}/contents/{path}?ref={branch}")
    return base64.b64decode(r["content"]).decode("utf8", "replace") if r and "content" in r else None


def npm(full, branch):
    t = file(full, branch, "package.json")
    if not t:
        return []
    try:
        j = json.loads(t)
    except ValueError:
        return []
    out = []
    for k in ("dependencies", "devDependencies", "peerDependencies"):
        for name, spec in (j.get(k) or {}).items():
            if isinstance(spec, str) and re.match(r"^(workspace:|file:|link:|git|github:|https?:|catalog:)", spec):
                continue
            out.append("pkg:npm/" + name.replace("@", "%40", 1) if name.startswith("@") else "pkg:npm/" + name)
    return out


def pypi(full, branch):
    t = file(full, branch, "pyproject.toml")
    if not t:
        return []
    try:
        j = tomllib.loads(t)
    except Exception:
        return []
    names = [re.split(r"[\s<>=!~;\[(]", d, 1)[0] for d in (j.get("project", {}).get("dependencies") or [])]
    names += [n for n in (j.get("tool", {}).get("poetry", {}).get("dependencies") or {}) if n.lower() != "python"]
    return ["pkg:pypi/" + re.sub(r"[-_.]+", "-", n).lower() for n in names if n]


def cargo(full, branch):
    t = file(full, branch, "Cargo.toml")
    if not t:
        return []
    try:
        j = tomllib.loads(t)
    except Exception:
        return []
    out = []
    for k in ("dependencies", "dev-dependencies"):
        for name, spec in (j.get(k) or {}).items():
            if isinstance(spec, dict) and ("path" in spec or "git" in spec or spec.get("workspace")):
                continue
            out.append("pkg:cargo/" + (spec.get("package", name) if isinstance(spec, dict) else name))
    return out


def main(out, start=0, count=40):
    stage1 = {p["purl"].replace("@", "%40", 1) if "/@" in p["purl"] else p["purl"] for p in json.load(open("eval/docs-sources/sample-stage1.json"))["packages"]}
    stage1 |= {p["purl"] for p in json.load(open("eval/docs-sources/sample-stage1.json"))["packages"]}
    chosen, purls = [], {}
    for lang, n, reader in (("TypeScript", 12, npm), ("Python", 6, pypi), ("Rust", 4, cargo)):
        for r in repos(lang, n):
            deps = reader(r["full_name"], r["default_branch"])
            chosen.append({"repo": r["full_name"], "language": lang, "deps": len(deps)})
            for d in deps:
                purls.setdefault(d, []).append(r["full_name"])
    pool = sorted((p for p in purls if p not in stage1 and p.replace("%40", "@") not in stage1), key=H)
    sample = [{"purl": p.replace("%40", "@"), "declared_by": purls[p]} for p in pool[start:start + count]]
    json.dump({"note": __doc__.strip().splitlines()[0], "repositories": chosen, "pool_size": len(pool), "packages": sample},
              open(out, "w"), indent=1)
    print(f"{len(chosen)} repositories, {len(pool)} distinct packages, {len(sample)} drawn from {start}")


main(sys.argv[1], *(int(a) for a in sys.argv[2:4]))
