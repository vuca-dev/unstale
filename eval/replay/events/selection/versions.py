import json, re, subprocess, sys
PK = {"next": "next", "prisma": "prisma", "nest": "@nestjs/core"}
def g(d, *a):
    return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True).stdout
def lockver(d, sha, pkg, major):
    files = g(d, "ls-tree", "-r", "--name-only", sha).splitlines()
    vs = set()
    for f in files:
        b = f.rsplit("/", 1)[-1]
        if b not in ("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock") or "node_modules" in f: continue
        t = g(d, "show", "%s:%s" % (sha, f))
        e = re.escape(pkg)
        pats = [r'"node_modules/%s"\s*:\s*\{\s*"version"\s*:\s*"([\d.]+)"' % e,          # npm
                r"(?m)^\s+'?/?%s@([\d.]+)'?(?:\(|:)" % e,                                   # pnpm v6-v9 keys
                r'(?m)^"?%s@[^\n]*:\n\s+version:? "?([\d.]+)' % e,                          # yarn
                r'"%s"\s*:\s*\[\s*"%s@([\d.]+)"' % (e, e)]                                   # bun
        for p in pats:
            vs |= set(re.findall(p, t))
    vs = [v for v in vs if v.split(".")[0] == str(major)]
    return sorted(vs, key=lambda v: tuple(map(int, v.split(".")))) 
c = json.load(open(sys.argv[1]))
MAJ = {"next": (15, 16), "prisma": (6, 7), "nest": (11, 12)}
for t in c:
    for x in c[t]:
        d = "clones/%s__" % x["repo"].replace("/", "_")
        o, n = MAJ[t]
        print(t, x["repo"], "old", lockver(d, x["parent"], PK[t], o), "new", lockver(d, x["sha"], PK[t], n))
