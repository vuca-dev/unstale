"""Slice 11 gold check (PREREG.md, "Gold"; slice 6's rule 7): the held-out majors set (H2) restricted to its three upgrade
guides, slice 3b's gpt-6-luna baseline and replicate and the MiniMax H2 run restricted to guide records, then
holdout/score.py compare (section bootstrap) of each against the baseline. No model calls.
    python3 -I slice11/gold11.py BASELINE_RUNS_DIR MM_RUN_DIR   (from eval/select)"""
import json, os, subprocess, sys
H = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
base_runs, mm_run = sys.argv[1], sys.argv[2]
OUT = os.path.join(H, "out", "slice11", "gold")
os.makedirs(OUT, exist_ok=True)
man = json.load(open(os.path.join(H, "holdout-majors/extraction/notes.json")))
guides = [n for n in man["notes"] if n["kind"] == "guide"]
json.dump({**man, "notes": guides}, open(os.path.join(OUT, "notes.json"), "w"), indent=1)
os.makedirs(os.path.join(OUT, "notes"), exist_ok=True)  # score.py reads the note texts beside the manifest (sections)
for n in guides:
    open(os.path.join(OUT, "notes", n["note_file"]), "w").write(open(os.path.join(H, "holdout-majors/extraction/notes", n["note_file"])).read())
lab = json.load(open(os.path.join(H, "holdout-majors/extraction/labels/adjudicated.json")))
keep = {n["note_file"] for n in guides}
json.dump({k: v for k, v in lab.items() if k in keep or not isinstance(v, list)}, open(os.path.join(OUT, "labels.json"), "w"), indent=1)
runs = {"base": os.path.join(base_runs, "vercel_openai_gpt-6-luna-two-call-heldout2"), "rep2": os.path.join(base_runs, "vercel_openai_gpt-6-luna-two-call-heldout2-rep2"), "mm": mm_run}
for name, run in runs.items():
    inc = json.load(open(os.path.join(run, "incoming.json")))
    json.dump([r for r in inc if "+guide" in r["key"]], open(os.path.join(OUT, name + ".json"), "w"), indent=1)
for b in ("rep2", "mm"):
    print("== base vs", b)
    out = subprocess.run([sys.executable, "-I", os.path.join(H, "holdout", "score.py"), "compare", os.path.join(OUT, "base.json"), os.path.join(OUT, b + ".json"),
                          "--labels", os.path.join(OUT, "labels.json"), "--notes", os.path.join(OUT, "notes.json"), "--kind", "extraction", "--unit", "section"], capture_output=True, text=True)
    print(out.stdout + out.stderr)
    open(os.path.join(OUT, "compare-%s.txt" % b), "w").write(out.stdout)
