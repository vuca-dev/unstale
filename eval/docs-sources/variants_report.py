"""Compare the diff and gating variants on a replay (replay.mts with per-section `v`, `edit`, `lost`, `leadGain`).

    python3 eval/docs-sources/variants_report.py <replay.json> [--skipped]

Token estimate per extraction call, calibrated on the 15 October Next.js run (26 Codex calls): a fixed ≈ 12,500 input
tokens (prompt and harness, ≈ 10,000 cached) plus one token per ≈ 4.3 characters of note.
"""
import collections
import json
import math
import sys

d = json.load(open([a for a in sys.argv[1:] if not a.startswith("--")][0]))
show = "--skipped" in sys.argv
OVER, CPT, PRE, MAX = 12_500, 4.3, 700, 30_000
PUB = {"marker", "guide"}
SKIP_SAFE = {"format", "link", "renumber", "typo"}
SKIP_ALL = SKIP_SAFE | {"reword"}
secs = [s for s in d["sections"] if "v" in s]
mod = [s for s in secs if s["status"] == "modified"]
pub = [s for s in secs if s["attribution"]["by"] in PUB]

print(f"## Variants on {len(secs)} sections ({len(mod)} modified, {len(pub)} versioned)\n")
print(f"Changed words lost by word marking (all sections): {sum(s['lost'] for s in secs)}\n")


def total(rows, k):
    return sum(s["v"][k] for s in rows)


print("| body | modified sections, chars | vs today | versioned sections, chars | vs today |")
print("|---|---|---|---|---|")
for k, label in (("line3", "3-line context (today)"), ("line3w", "3-line + word marks"), ("block", "block context"), ("blockw", "block + word marks")):
    print(f"| {label} | {total(mod, k):,} | {total(mod, k) / total(mod, 'line3') - 1:+.0%} | {total(pub, k):,} | {total(pub, k) / total(pub, 'line3') - 1:+.0%} |")
lead = [s for s in mod if s["leadGain"]]
print(f"\nBlock context adds a lead-in line (\"…:\") that 3-line context lacks in {len(lead)} of {len(mod)} modified sections ({len(lead) / len(mod):.1%}); in versioned sections: {sum(1 for s in pub if s.get('leadGain'))} of {len(pub)}.\n")

# Edit kinds: the module's exact classifier against the eval heuristic.
print("Edit kinds, module (rows) against eval heuristic (columns), all sections:\n")
kinds = ["format", "link", "renumber", "typo", "reword", "substantive"]
m = collections.Counter((s["edit"], s["noise"]) for s in secs)
print("| module \\ eval | " + " | ".join(kinds) + " |")
print("|---|" + "---|" * len(kinds))
for a in kinds:
    print(f"| {a} | " + " | ".join(str(m[(a, b)]) for b in kinds) + " |")
print()


def plan(rows, body, skip):
    groups = collections.defaultdict(list)
    for s in rows:
        if s["edit"] in skip:
            continue
        groups[(s["target"], s["date"], s["file"], s["attribution"]["version"])].append(s)
    calls = chars = 0
    for g in groups.values():
        c = sum(s["v"][body] + 80 for s in g) + PRE
        calls += max(1, math.ceil(c / MAX))
        chars += c
    return calls, chars, calls * OVER + chars / CPT


print("Extraction of versioned sections over the window (calls, note characters, estimated input tokens):\n")
print("| variant | calls | chars | ≈ input tokens | vs today |")
print("|---|---|---|---|---|")
base = plan(pub, "line3", set())[2]
for label, body, skip in (
    ("today: 3-line, no gate", "line3", set()),
    ("block + word marks", "blockw", set()),
    ("block + word marks, gate format/link/renumber/typo", "blockw", SKIP_SAFE),
    ("block + word marks, gate also reword", "blockw", SKIP_ALL),
):
    c, ch, t = plan(pub, body, skip)
    print(f"| {label} | {c} | {ch:,} | {t / 1000:,.0f}k | {t / base - 1:+.0%} |")
gated = collections.Counter(s["edit"] for s in pub if s["edit"] in SKIP_ALL)
print(f"\nVersioned sections the gate drops: {dict(gated)}\n")

if show:
    print("### Every versioned section the gate would drop (review for false drops)\n")
    for s in pub:
        if s["edit"] in SKIP_ALL:
            body = (s.get("blockw") or s.get("hunks") or "")[:700].replace("\n", "\n    ")
            print(f"- **{s['edit']}** {s['target']} {s['date']} `{s['file']}` {' > '.join(s['path'])} → {s['attribution'].get('version')}\n    {body}\n")
