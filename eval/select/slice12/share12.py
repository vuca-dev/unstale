"""Slice 12 step 1: the share of production's extraction (A+B) spend that is release notes, against guides and docs.

Every gateway line of the production usage log (the restored state's central/usage.jsonl, October 2026) is matched to
the cached answer that produced it: inventory.mts records the usage of every chunk's cached step-A answer and of its
step-B (label) answer, and a log line is assigned to the chunk whose usage tuple (input, cached input, output,
reasoning tokens) it equals, the same technology first when the line names one. Lines left over are other calls
(the classifier's chat fallback, docs and guide calls whose chunks are no longer rebuilt, truncated answers' pieces).

    python3 -I eval/select/slice12/share12.py <restored central dir> eval/select/out/slice12/chunks.jsonl

Prints $ and calls by source and step, per day and phase, and the projection at 20k technologies.
"""
import collections
import json
import sys

central, chunks_path = sys.argv[1], sys.argv[2]
SOURCE = {"release": "release", "guide": "guide", "docs-guide": "guide", "docs": "docs"}

want = collections.defaultdict(list)  # usage tuple -> [(tech, source, step)]
for line in open(chunks_path):
    c = json.loads(line)
    for step, u in (("A", c.get("usageA")), ("B", c.get("usageB"))):
        if not u:
            continue
        k = (u.get("input_tokens"), u.get("cached_input_tokens", 0), u.get("output_tokens"), u.get("reasoning_tokens") or 0)
        want[k].append((c["tech"], SOURCE[c["source"]], step))

dollars = collections.Counter()
calls = collections.Counter()
by_day = collections.defaultdict(collections.Counter)
by_phase = collections.defaultdict(collections.Counter)
techs = collections.defaultdict(set)
total = 0.0
for line in open(f"{central}/usage.jsonl"):
    u = json.loads(line)
    if u.get("api") != "vercel" or "dollars" not in u:
        continue
    d = u["dollars"] or 0
    total += d
    k = (u.get("input_tokens"), u.get("cached_input_tokens", 0), u.get("output_tokens"), u.get("reasoning_tokens") or 0)
    cands = want.get(k) or []
    pick = next((x for x in cands if x[0] == u.get("tech")), cands[0] if cands else None)
    if pick:
        cands.remove(pick)
        cls = f"{pick[1]}:{pick[2]}"
        techs[pick[1]].add(pick[0])
    else:
        cls = "unmatched"
    dollars[cls] += d
    calls[cls] += 1
    by_day[u["at"][:10]][cls] += d
    by_phase[u.get("phase", "-")][cls] += d

print(f"gateway total ${total:.4f} over {sum(calls.values())} calls")
print("| Class | Calls | $ | Share of total |")
print("|---|---|---|---|")
for cls, d in sorted(dollars.items(), key=lambda x: -x[1]):
    print(f"| {cls} | {calls[cls]} | {d:.4f} | {100 * d / total:.1f}% |")
ab = {s: dollars[f"{s}:A"] + dollars[f"{s}:B"] for s in ("release", "guide", "docs")}
matched = sum(ab.values())
print()
print("A+B by source (matched lines): " + ", ".join(f"{s} ${v:.4f} ({100 * v / matched:.1f}%)" for s, v in ab.items()))
print("technologies with matched spend: " + ", ".join(f"{s} {len(v)}" for s, v in techs.items()))
print()
print("| Day | release A+B | guide A+B | docs A+B | unmatched |")
print("|---|---|---|---|---|")
for day in sorted(by_day):
    c = by_day[day]
    print(f"| {day} | {c['release:A'] + c['release:B']:.4f} | {c['guide:A'] + c['guide:B']:.4f} | {c['docs:A'] + c['docs:B']:.4f} | {c['unmatched']:.4f} |")
print()
print("| Phase | release A+B | guide A+B | docs A+B | unmatched |")
print("|---|---|---|---|---|")
for ph in sorted(by_phase):
    c = by_phase[ph]
    print(f"| {ph} | {c['release:A'] + c['release:B']:.4f} | {c['guide:A'] + c['guide:B']:.4f} | {c['docs:A'] + c['docs:B']:.4f} | {c['unmatched']:.4f} |")
