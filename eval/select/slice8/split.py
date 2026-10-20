"""Slice 8 split (PREREG.md "Sets"): each cached step-A answer in the inventory is matched to its call in the state's
usage log (the cached answer's token counts; equal counts are taken in time order), which gives the call's time,
phase and provider-reported dollars.

  dev          answered before 2026-10-19T00:00Z
  heldout      answered on or after 2026-10-19T00:00Z, and the technology's family (repository owner) has no dev chunk
  heldout-time answered on or after 2026-10-19T00:00Z, family also seen in dev (time split only; secondary)

    python3 -I slice8/split.py <state>/central/usage.jsonl     (from eval/select)
Writes out/slice8/rows.jsonl: the inventory's A0/A+ rows with split, at, phase, dollars (text kept)."""
import json, os, sys, collections
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(H, "out", "slice8")
CUT = "2026-10-19"

uses = collections.defaultdict(list)
for l in open(sys.argv[1]):
    r = json.loads(l)
    if r.get("api") != "vercel":
        continue
    uses[(r["input_tokens"], r.get("cached_input_tokens", 0), r["output_tokens"], r.get("reasoning_tokens", 0))].append(r)
for v in uses.values():
    v.sort(key=lambda r: r["at"])

rows = [json.loads(l) for l in open(os.path.join(OUT, "chunks.jsonl"))]
rows = [r for r in rows if r["status"] in ("A0", "A+")]
for r in rows:
    u = r.get("usage") or {}
    L = uses.get((u.get("input_tokens"), u.get("cached_input_tokens", 0), u.get("output_tokens"), u.get("reasoning_tokens", 0)))
    x = L.pop(0) if L and len(L) > 1 else (L[0] if L else None)
    r["at"] = x["at"] if x else None
    r["phase"] = (x or {}).get("phase") or "unlabelled"
    r["dollars"] = (x or {}).get("dollars", 0.0)
fam = lambda r: (r.get("repo") or r["tech"]).split("/")[0].lower()
dev_fams = {fam(r) for r in rows if r["at"] and r["at"] < CUT}
for r in rows:
    if not r["at"]:
        r["split"] = "unmatched"
    elif r["at"] < CUT:
        r["split"] = "dev"
    else:
        r["split"] = "heldout-time" if fam(r) in dev_fams else "heldout"
with open(os.path.join(OUT, "rows.jsonl"), "w") as f:
    for i, r in enumerate(rows):
        r["id"] = i
        f.write(json.dumps(r) + "\n")
c = collections.Counter((r["split"], r["status"]) for r in rows)
print({f"{a} {b}": n for (a, b), n in sorted(c.items())})
