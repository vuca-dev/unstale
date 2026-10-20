"""Slice 6 gold check inputs: the held-out majors set restricted to its three upgrade guides (manifest and adjudicated
labels), slice 3b's gpt-6-luna baseline and replicate restricted to guide records, and the shared arm's records.
    python3 -I slice6/gold_prep.py   (from eval/select)"""
import json, os
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(H, "out", "slice6", "gold", "score")
man = json.load(open(os.path.join(H, "holdout-majors/extraction/notes.json")))
guides = [n for n in man["notes"] if n["kind"] == "guide"]
json.dump({**man, "notes": guides}, open(os.path.join(OUT, "notes.json"), "w"), indent=1)
lab = json.load(open(os.path.join(H, "holdout-majors/extraction/labels/adjudicated.json")))
keep = {n["note_file"] for n in guides}
json.dump({k: v for k, v in lab.items() if k in keep or not isinstance(v, list)}, open(os.path.join(OUT, "labels.json"), "w"), indent=1)
for name, run in (("base", "vercel_openai_gpt-6-luna-two-call-heldout2"), ("rep2", "vercel_openai_gpt-6-luna-two-call-heldout2-rep2")):
    inc = json.load(open(os.path.join(H, "out/slice3b/runs", run, "incoming.json")))
    json.dump([r for r in inc if "+guide" in r["key"]], open(os.path.join(OUT, name + ".json"), "w"), indent=1)
rows = [json.loads(l) for l in open(os.path.join(H, "out/slice6/gold/shared/pairs.jsonl"))] if os.path.exists(os.path.join(H, "out/slice6/gold/shared/pairs.jsonl")) else []
json.dump([r for row in rows for r in row["incoming"]], open(os.path.join(OUT, "shared.json"), "w"), indent=1)
print({k: len(json.load(open(os.path.join(OUT, k + ".json")))) for k in ("base", "rep2", "shared")})
