"""Slice 13 held-out set (PREREG.md, "Set"): production release notes first ingested on or after 22 October 2026.

    python3 -I eval/select/slice13/select13.py <restored store>/central eval/select/out/slice13h/chunks.jsonl \
        eval/select/slice13/heldout.json [--since 2026-10-22T00:00:00Z]

Built like slice 12's set (slice12/select12.py), with a date rule in place of slice 8's exclusions:
- release notes (not guides or docs notes) whose every non-empty chunk has a cached gpt-6-luna step-A answer
  (inventory13.mts: status A+ or A0, none missing, unparsed or truncated);
- every such chunk first answered on or after --since: each chunk is dated by the production usage log line whose usage
  tuple (input, cached input, output, reasoning tokens) equals its cached step-A answer's, the same technology first
  when the line names one (slice 8's and slice 12's matching). A chunk with no matching line has no date and makes its
  release ineligible. Every usage log under the store's central directory is read (usage.jsonl and any archived month);
- excluded: the repositories of every earlier extraction or label set (slice 12's list) and of slice 12's set, which is
  slice 13's DEV set. Chunks of earlier sets were all answered before 21 October, so the date rule excludes them.

Strata as slice 12 (a release is in the first that holds): MAJOR (version x.0 or x.0.0), LARGE (>= 8,000 characters),
NPM, PYPI, taking at most 24, 12, 54 and 36. Within a stratum, releases are taken in order of
sha256("20261022|tech|version"), at most one per technology per stratum, two per technology and three per repository.
Exit status 2 when fewer than 100 releases are selected (PREREG: build again from a later state).
"""
import collections
import glob
import hashlib
import json
import os
import re
import sys

central, chunks_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
since = sys.argv[sys.argv.index("--since") + 1] if "--since" in sys.argv else "2026-10-22T00:00:00Z"
TAKE = {"major": 24, "large": 12, "npm": 54, "pypi": 36}
MIN_TOTAL = 100
EARLIER = re.compile(
    r"posthog|fastapi/typer|tiangolo/typer|encode/uvicorn|Kludex/uvicorn|colinhacks/zod|sveltejs/kit|mswjs|python/mypy|"
    r"huggingface/transformers|vercel/next\.js|prisma/prisma|nestjs/|^vercel/ai$|aws-sdk|tiptap|remix-run/react-router",
    re.I,
)
here = os.path.dirname(os.path.abspath(__file__))
dev = json.load(open(os.path.join(here, "..", "slice12", "set.json")))["releases"]
dev_repos = {r["repo"] for r in dev}

key = lambda u: (u.get("input_tokens"), u.get("cached_input_tokens", 0), u.get("output_tokens"), u.get("reasoning_tokens") or 0)
rel = collections.defaultdict(list)
want = collections.defaultdict(list)  # usage tuple -> chunks (release notes, step A)
for line in open(chunks_path):
    c = json.loads(line)
    if c["source"] != "release":
        continue
    rel[(c["tech"], c["version"])].append(c)
    if c.get("usageA") and c["status"] in ("A+", "A0"):
        want[key(c["usageA"])].append(c)

logs = [f for f in glob.glob(os.path.join(central, "**", "usage*.jsonl"), recursive=True) if f"{os.sep}cache{os.sep}" not in f]
lines = []
for f in logs:
    for line in open(f):
        u = json.loads(line)
        if u.get("api") == "vercel" and "at" in u and key(u) in want:
            lines.append(u)
dated = {}  # id(chunk) -> first answered
for u in sorted(lines, key=lambda u: u["at"]):
    cands = [c for c in want[key(u)] if id(c) not in dated]
    pick = next((c for c in cands if c["tech"] == u.get("tech")), cands[0] if cands else None)
    if pick:
        dated[id(pick)] = u["at"]

pool, why = [], collections.Counter()
for (tech, version), cs in rel.items():
    st = [c["status"] for c in cs]
    if any(s in ("miss", "unparsed", "trunc") for s in st) or not any(s in ("A+", "A0") for s in st):
        why["not fully answered by gpt-6-luna"] += 1
        continue
    answered = [c for c in cs if c["status"] in ("A+", "A0")]
    if any(id(c) not in dated for c in answered):
        why["a chunk has no usage line"] += 1
        continue
    if any(dated[id(c)] < since for c in answered):
        why["answered before --since"] += 1
        continue
    repo = cs[0]["repo"] or ""
    if EARLIER.search(repo) or repo in dev_repos:
        why["earlier or DEV repository"] += 1
        continue
    eco = (cs[0]["components"] or ["pkg:none/"])[0].split("/")[0].removeprefix("pkg:")
    chars = sum(c["chars"] for c in cs)
    major = bool(re.match(r"^v?\d+\.0(\.0)?$", version))
    stratum = "major" if major else "large" if chars >= 8000 else eco if eco in ("npm", "pypi") else None
    if not stratum:
        why["no stratum (other ecosystem)"] += 1
        continue
    first = min(dated[id(c)] for c in answered)
    pool.append({"tech": tech, "version": version, "repo": repo, "stratum": stratum, "chars": chars, "first_answered": first, "base_records": sum(c.get("records", 0) for c in cs)})

order = lambda r: hashlib.sha256(f"20261022|{r['tech']}|{r['version']}".encode()).hexdigest()
per_tech, per_repo, chosen = {}, {}, []
for stratum, n in TAKE.items():
    seen = set()
    for r in sorted((r for r in pool if r["stratum"] == stratum), key=order):
        if len([x for x in chosen if x["stratum"] == stratum]) >= n:
            break
        if r["tech"] in seen or per_tech.get(r["tech"], 0) >= 2 or per_repo.get(r["repo"], 0) >= 3:
            continue
        seen.add(r["tech"])
        per_tech[r["tech"]] = per_tech.get(r["tech"], 0) + 1
        per_repo[r["repo"]] = per_repo.get(r["repo"], 0) + 1
        chosen.append(r)

summary = {s: {"pool": sum(r["stratum"] == s for r in pool), "releases": sum(r["stratum"] == s for r in chosen), "base_records": sum(r["base_records"] for r in chosen if r["stratum"] == s)} for s in TAKE}
print(json.dumps({"since": since, "usage_logs": len(logs), "excluded": why, "pool": len(pool), "summary": summary, "technologies": len({r["tech"] for r in chosen}), "releases": len(chosen)}))
if len(chosen) < MIN_TOTAL:
    print(f"only {len(chosen)} releases (< {MIN_TOTAL}): no set written; build again from a later state", file=sys.stderr)
    sys.exit(2)
json.dump({"seed": 20261022, "since": since, "summary": summary, "technologies": len({r["tech"] for r in chosen}), "releases": chosen}, open(out_path, "w"), indent=1)
