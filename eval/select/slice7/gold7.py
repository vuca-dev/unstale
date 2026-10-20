"""Slice 7 gold check inputs (PREREG.md condition 7): slice 6's guides-only manifest, labels and slice 3b baseline and
replicate (out/slice6/gold/score, from slice6/gold_prep.py), plus the candidate's records for the three guides.
    python3 -I slice7/gold7.py jev-r3   (from eval/select); then holdout/score.py compare (RESULTS.md)"""
import json, os, shutil, sys
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
S6 = os.path.join(H, "out", "slice6", "gold", "score")
OUT = os.path.join(H, "out", "slice7", "gold", "score")
os.makedirs(OUT, exist_ok=True)
for f in ("notes.json", "labels.json", "base.json", "rep2.json"):
    shutil.copy(os.path.join(S6, f), OUT)
if not os.path.exists(os.path.join(OUT, "notes")):
    shutil.copytree(os.path.join(S6, "notes"), os.path.join(OUT, "notes"))
arm = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(H, "out", "slice7", "gold", arm, "pairs.jsonl"))]
json.dump([r for row in rows for r in row["incoming"]], open(os.path.join(OUT, arm + ".json"), "w"), indent=1)
print({k: len(json.load(open(os.path.join(OUT, k + ".json")))) for k in ("base", "rep2", arm)})
