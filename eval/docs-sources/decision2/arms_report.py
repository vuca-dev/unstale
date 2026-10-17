"""Compare decision 2 arms (arms.sh): new and merged records, flagged duplicates, key facts, tokens and cost.

    python3 eval/docs-sources/decision2/arms_report.py <baseline-records.json> <out-dir>

A flagged duplicate is a new record whose best candidate was judged p >= 0.7 "same" and blocked by a guard.
"""
import json, os, re, glob, collections, sys
BASE = json.load(open(sys.argv[1]))["records"]
OUT = sys.argv[2]
# Prices (per million tokens): Luna input 0.20, cached input 0.02 (assumed: no post-cut cached rate published), output 1.20; Jev input 0.042, output free.
P = {"in": 0.20, "cached": 0.02, "out": 1.20, "jev": 0.042}
runs = {}
for d in sorted(glob.glob(f"{OUT}/*/")):
    name = os.path.basename(d.rstrip("/"))
    if os.path.exists(f"{d}t0") and "done" in open(f"{d}log").read():
        runs[name] = (d.rstrip("/"), open(f"{d}t0").read().strip())
FACTS = {
    "next analyze export (16.4)": lambda r: "analyze" in (r["subject"] + r["summary"]).lower() and "16.4" in json.dumps(r["releases"]),
    "useActionState": lambda r: "useactionstate" in (r["subject"] + r["summary"]).lower(),
    "React 19 minimum": lambda r: "react" in r["subject"].lower() and "19" in r["summary"],
    "@next/font removed": lambda r: "next/font" in (r["subject"] + r["summary"]).lower(),
    "NextRequest geo/ip": lambda r: "nextrequest" in (r["subject"] + r["summary"]).lower().replace(" ", ""),
}
rows = []
for name, (clone, t0) in runs.items():
    after = json.load(open(f"{clone}/central/records/next.json"))["records"]
    new = [k for k in after if k not in BASE and after[k]["status"] == "active"]
    revised = [k for k in BASE if k in after and after[k].get("revision") != BASE[k].get("revision")]
    flagged = 0
    for k in new:
        j = sorted(after[k]["history"][0].get("judged", []), key=lambda x: -x["p"])
        if j and j[0]["p"] >= 0.7 and j[0]["outcome"].startswith("guard"):
            flagged += 1
    base = lambda k: re.sub(r"~\d+$", "", k)
    active = collections.Counter(base(k) for k, r in after.items() if r["status"] == "active")
    same_subject = sum(1 for k in new if active[base(k)] > 1)
    marks = sum(1 for k in new for e in after[k]["evidence"] if re.search(r"\[-|\{\+", e["quote"]))
    touched = [after[k] for k in new + revised]
    facts = sum(1 for f in FACTS.values() if any(f(r) for r in touched))
    use = [json.loads(l) for l in open(f"{clone}/central/usage.jsonl")]
    use = [u for u in use if str(u.get("at", "")) >= t0]
    lu = [u for u in use if u.get("model") == "gpt-5.6-luna"]
    jv = [u for u in use if u.get("model") == "jev-1.13.0"]
    li, lc, lo = (sum(u.get(x) or 0 for u in lu) for x in ("input_tokens", "cached_input_tokens", "output_tokens"))
    ji = sum(u.get("input_tokens") or 0 for u in jv)
    cost = ((li - lc) * P["in"] + lc * P["cached"] + lo * P["out"] + ji * P["jev"]) / 1e6
    rows.append((name, len(new), len(revised), flagged, same_subject, marks, f"{facts}/{len(FACTS)}", len(lu), li, lo, len(jv), ji, cost))
print("| run | new | merged into existing | flagged duplicates | same-subject overlaps | marks in quotes | key facts | Luna calls | Luna in | Luna out | Jev calls | Jev in | ≈ cost |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(f"${x:.3f}" if i == 12 else (f"{x:,}" if isinstance(x, int) else str(x)) for i, x in enumerate(r)) + " |")
