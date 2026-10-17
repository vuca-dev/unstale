"""Audit table and counts for docs/match-audit-heldout.md from pairs.json and verdicts.json (no model calls)."""
import difflib, json, re, sys
from pathlib import Path

here = Path(__file__).parent
pairs = json.load(open(here / "pairs.json"))
over = {k: v for k, v in json.load(open(here / "verdicts.json")).items() if not k.startswith("_")}

def norm(q):
    q = re.sub(r"\bGHSA(?:-[a-z0-9]{4}){3}\b|\bCVE-\d{4}-\d{4,}\b", " ", q, flags=re.I)
    q = re.sub(r"\(\s*#\d+\s*\)|#\d+\b", " ", q)
    return re.sub(r"\s+", " ", re.sub(r"[`*_\\]", "", q).lower()).strip()

rows, n = [], {"merge": [], "near": [], "blocked": []}
for p in pairs:
    v = over.get(str(p["n"]))
    verdict = v[0] if v else ("SAME" if p["reference"] == "same" else "DIFFERENT")
    note = v[1] if v else ""
    sim = max((difflib.SequenceMatcher(None, norm(p["incoming"]["quote"]), norm(x["quote"]), autojunk=False).ratio() for x in p["candidate"]["items"]), default=0)
    p["verdict"] = verdict
    n[p["kind"]].append(p)
    i = p["incoming"]
    rows.append(f"| {p['n']} | {p['kind']}{' (cross)' if p['cross'] else ''} | {p['candidate']['id']} | {i['key']} | {p['p']} | {p['outcome']} | {p['reference']} | {verdict} | {sim:.2f} | {note} |")

def cnt(ps, v): return sum(1 for p in ps if p["verdict"] == v)
m = n["merge"]
out = {
    "merges": len(m), "merges_within": sum(not p["cross"] for p in m), "merges_cross": sum(p["cross"] for p in m),
    "merge_SAME": cnt(m, "SAME"), "merge_DIFFERENT": cnt(m, "DIFFERENT"), "merge_UNSURE": cnt(m, "UNSURE"),
    "false_per_100": round(100 * (cnt(m, "DIFFERENT") + 0.5 * cnt(m, "UNSURE")) / len(m), 2),
    "merges_identical_quote": sum(1 for p in m if any(p["incoming"]["quote"].strip() == x["quote"].strip() for x in p["candidate"]["items"])),
    "near": len(n["near"]), "blocked": len(n["blocked"]),
    "missed_SAME": cnt(n["near"] + n["blocked"], "SAME"), "missed_UNSURE": cnt(n["near"] + n["blocked"], "UNSURE"),
    "codex_disagreements": sum(1 for p in pairs if (p["reference"] == "same") != (p["verdict"] == "SAME")),
}
print(json.dumps(out))
if "--table" in sys.argv:
    print("| # | pair | record (candidate) | incoming | p | outcome | Codex | verdict | quote similarity | note |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    print("\n".join(rows))
