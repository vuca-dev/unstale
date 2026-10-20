"""Slice 12 held-out set: production release notes no earlier slice has used (PREREG.md, "Set").

    python3 -I eval/select/slice12/select12.py eval/select/out/slice12/chunks.jsonl <slice 8 out dir> eval/select/slice12/set.json

Pool: release notes (not guides or docs notes) of the 20 October 17:33Z state whose every non-empty chunk has a cached
gpt-6-luna step-A answer, excluding
- every chunk slice 8 called a model on or fitted with: its DEV split (fitting), its HELD-OUT split (replicated) and
  the chunks its rule skipped (replicated). Slice 8's HELD-OUT-TIME chunks the rule did not skip entered only an
  aggregate count (no call, no record looked at) and stay in the pool, as do releases first extracted after slice 8's
  state (14:22Z);
- the repositories of every earlier extraction or label set: the extraction gate (Next.js, Prisma, NestJS), H1
  (posthog-js, typer, uvicorn, zod), H2 (SvelteKit, msw, mypy, transformers), slices 6, 7 and 11's guide units (AI SDK,
  Next.js, AWS SDK, Tiptap, React Router, NestJS).
Every chunk in the pool was answered on or after 19 October 2026 (slice 8's split), so first ingested after 15 October.

Strata (a release is in the first that holds): MAJOR (version x.0 or x.0.0), LARGE (≥ 8,000 characters of notes),
NPM, PYPI. Within a stratum, releases are taken in order of sha256("20261020|tech|version"), at most one per
technology per stratum, two per technology and three per repository overall.
"""
import hashlib
import json
import re
import sys

chunks_path, s8, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
TAKE = {"major": 24, "large": 12, "npm": 54, "pypi": 36}
EARLIER = re.compile(
    r"posthog|fastapi/typer|tiangolo/typer|encode/uvicorn|Kludex/uvicorn|colinhacks/zod|sveltejs/kit|mswjs|python/mypy|"
    r"huggingface/transformers|vercel/next\.js|prisma/prisma|nestjs/|^vercel/ai$|aws-sdk|tiptap|remix-run/react-router",
    re.I,
)

rows = [json.loads(l) for l in open(f"{s8}/rows.jsonl")]
skipped = set()
for f in ("heldout-skipped", "heldout-time-skipped", "dev-skipped"):
    for l in open(f"{s8}/rep/{f}.jsonl"):
        skipped.add(json.loads(l)["id"])
used = {r["key"] for r in rows if r["split"] != "heldout-time" or r["id"] in skipped}

rel = {}
for line in open(chunks_path):
    c = json.loads(line)
    if c["source"] == "release":
        rel.setdefault((c["tech"], c["version"]), []).append(c)

pool = []
for (tech, version), cs in rel.items():
    st = [c["status"] for c in cs]
    if any(s in ("miss", "unparsed", "trunc") for s in st) or not any(s in ("A+", "A0") for s in st):
        continue
    if any(c.get("keyA") in used for c in cs) or EARLIER.search(cs[0]["repo"] or ""):
        continue
    eco = (cs[0]["components"] or ["pkg:none/"])[0].split("/")[0].removeprefix("pkg:")
    chars = sum(c["chars"] for c in cs)
    major = bool(re.match(r"^v?\d+\.0(\.0)?$", version))
    stratum = "major" if major else "large" if chars >= 8000 else eco if eco in ("npm", "pypi") else None
    if stratum:
        pool.append({"tech": tech, "version": version, "repo": cs[0]["repo"], "stratum": stratum, "chars": chars, "base_records": sum(c.get("records", 0) for c in cs)})

order = lambda r: hashlib.sha256(f"20261020|{r['tech']}|{r['version']}".encode()).hexdigest()
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
json.dump({"seed": 20261020, "summary": summary, "technologies": len({r["tech"] for r in chosen}), "releases": chosen}, open(out_path, "w"), indent=1)
print(json.dumps(summary), "technologies", len({r["tech"] for r in chosen}), "releases", len(chosen))
