"""Selection rule (stage 2) over detect_ok.jsonl -> chosen events. Deterministic."""
import json, hashlib, re, sys
TECHRE = {"next": r"next", "prisma": r"prisma", "nest": r"nest"}
NEED = 4
rows, seen = [], set()
for l in open(sys.argv[1]):
    d = json.loads(l)
    if (d["tech"], d["repo"]) in seen: continue
    seen.add((d["tech"], d["repo"]))
    why = []
    if not d["found"]: why.append("no first-parent commit moves the major")
    else:
        if d["code_files"] < 3: why.append("version-only (<3 non-manifest files changed)")
        if d["tests"] < 10: why.append("<10 test files at P")
        if d["commits_before"] < 300: why.append("<300 commits before P")
        if d["date"][:10] > "2026-10-08": why.append("upgrade <7 days old")
        if not re.search(TECHRE[d["tech"]], d["msg"], re.I): why.append("upgrade commit subject does not name the technology")
        if re.search(r"sample", d["repo"], re.I): why.append("sample project")
        if not d.get("manifests"): why.append("major moved only in an example/fixture/test manifest")
    d["why"] = why
    rows.append(d)
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
chosen = {}
for t in ("next", "prisma", "nest"):
    ok = sorted((d for d in rows if d["tech"] == t and not d["why"]), key=lambda d: h(d["repo"]))
    chosen[t] = ok[:NEED]
    for i, d in enumerate(ok): d["rank"] = i
for d in rows:
    tag = "CHOSEN" if any(d is c for c in sum(chosen.values(), [])) else ("pass(reserve)" if not d["why"] else "; ".join(d["why"]))
    print("%-6s %-45s %s" % (d["tech"], d["repo"], tag))
json.dump(chosen, open(sys.argv[2], "w"), indent=1)
