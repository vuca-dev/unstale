"""Find the first-parent commit that moves a package's major old->new in any package.json; report rule metrics.
   python3 -I detect.py <tech> <owner/repo> <clonedir>  -> one JSON line"""
import json, re, subprocess, sys, os
T = {"next": (["next"], 15, 16, "2025-10-21"), "prisma": (["prisma", "@prisma/client"], 6, 7, "2025-11-18"),
     "nest": (["@nestjs/core", "@nestjs/common"], 11, 12, "2026-01-01")}
tech, repo, d = sys.argv[1:4]
names, old, new, since = T[tech]
def g(*a, check=True):
    return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True, check=check).stdout
if not os.path.exists(d):
    subprocess.run(["git", "clone", "-q", *([] if os.environ.get("FULLCLONE") else ["--filter=blob:none"]), "https://github.com/%s.git" % repo, d], check=True, capture_output=True)
pat = "|".join(re.escape(n) for n in names)
log = g("log", "-E", "--first-parent", "--reverse", "-p", "--since=" + since, "--format=@@C %H %cI", "-G", '"(%s)"\\s*:' % pat, "--", ":(glob)**/package.json")
spec = re.compile(r'^([+-])\s*"(%s)"\s*:\s*"[^\d"]*(\d+)\.?' % pat)
res = None
cur = None; plus = set(); minus = set()
def done():
    global res
    if cur and res is None and new in plus and old in minus:
        res = cur
SKIP = re.compile(r"(^|/)([\w.-]*(examples?|fixtures?|demos?|playground|sandbox)[\w.-]*|__fixtures__|tests?|e2e|dev|dev[_-][\w.-]*)(/|$)", re.I)
fname = ""
manifests = {}
for line in log.splitlines():
    if line.startswith("+++ "):
        fname = line[6:]
        continue
    if line.startswith("@@C "):
        done(); cur = line.split()[1:3]; plus, minus = set(), set()
        continue
    m = spec.match(line)
    if m and not SKIP.search(fname):
        if m.group(1) == "+" and int(m.group(3)) == new: manifests.setdefault(cur[0] if cur else "", set()).add(fname)
        (plus if m.group(1) == "+" else minus).add(int(m.group(3)))
done()
out = dict(tech=tech, repo=repo)
if not res:
    print(json.dumps(dict(out, found=False))); sys.exit()
sha, date = res
par = g("rev-parse", sha + "^").strip()
files = [f for f in g("diff", "--name-only", par, sha).splitlines()]
LOCK = re.compile(r"(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.yarn/.*|CHANGELOG\.md|\.changeset/.*)$")
code = [f for f in files if not LOCK.search(f)]
tree = g("ls-tree", "-r", "--name-only", par).splitlines()
tests = sum(1 for f in tree if re.search(r"(\.(test|spec)\.[jt]sx?$|(^|/)(__tests__|e2e|test|tests)/)", f) and "node_modules" not in f)
nbefore = int(g("rev-list", "--count", par).strip())
msg = g("show", "-s", "--format=%s", sha).strip()
parents = len(g("show", "-s", "--format=%P", sha).split())
print(json.dumps(dict(out, found=True, manifests=sorted(manifests.get(sha, [])), sha=sha, parent=par, date=date, msg=msg, merge=parents > 1, files=len(files), code_files=len(code),
                      code_sample=code[:12], tests=tests, commits_before=nbefore)))
