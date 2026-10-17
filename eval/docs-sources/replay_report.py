"""Summarise the docs replays (replay.mts, wayback.mts): volume, edit kinds, the version share, extraction input.

    python3 eval/docs-sources/replay_report.py <replay.json> [<wayback.json>] [--markers]

The version share is the decision input for the `observed` field: of the section
changes the daily pass would record, how many carry a version (marker or upgrade guide) and so can be published.
"""
import collections
import json
import statistics
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
show_markers = "--markers" in sys.argv
rep = json.load(open(args[0]))
wb = json.load(open(args[1])) if len(args) > 1 else None
DAYS = rep["days"]
PUB = {"marker", "guide"}


def pct(n, d):
    return f"{100 * n / d:.0f} %" if d else "–"


def table(rows, head):
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for r in rows:
        print("| " + " | ".join(str(x) for x in r) + " |")
    print()


res = rep["results"]
secs = rep["sections"]
mass = {(r["id"], d) for r in res for d in r.get("massEditDays", [])}
ok = [r for r in res if not r.get("error")]
print(f"## Git replay: {len(res)} sources, {DAYS} days from {rep['start']}\n")
print(f"Errors: {len(res) - len(ok)} " + ", ".join(f"{r['id']} ({r['error'][:60]})" for r in res if r.get("error")) + "\n")

# Volume: events (one per changed page per day) and active days per source.
for kind in ("docs", "readme"):
    rs = [r for r in ok if r["kind"] == kind]
    if not rs:
        continue
    events = [sum(r["events"].values()) for r in rs]
    active = [r["activeDays"] for r in rs]
    quiet = sum(1 for r in rs if not r["commitsInWindow"])
    print(f"**{kind}** ({len(rs)} sources): {quiet} with no change in {DAYS} days; active days per source median {statistics.median(active)}, max {max(active)}; events per source median {statistics.median(events)}, p90 {sorted(events)[int(0.9 * (len(events) - 1))]}, max {max(events)}; mass-edit days {sum(len(r.get('massEditDays', [])) for r in rs)}\n")


def breakdown(rows, label):
    n = len(rows)
    noise = collections.Counter(s["noise"] for s in rows)
    by = collections.Counter(s["attribution"]["by"] for s in rows)
    sub = [s for s in rows if s["noise"] == "substantive"]
    sub_pub = sum(1 for s in sub if s["attribution"]["by"] in PUB)
    pub = sum(1 for s in rows if s["attribution"]["by"] in PUB)
    return [label, n, *(pct(noise[k], n) for k in ("format", "link", "renumber", "typo", "reword", "substantive")), pct(pub, n), f"{len(sub)} / {sub_pub} ({pct(sub_pub, len(sub))})", ", ".join(f"{k} {v}" for k, v in by.most_common())]


head = ["set", "sections", "format", "link", "renumber", "typo", "reword", "substantive", "versioned (all)", "substantive / versioned", "attribution"]
rows = [
    breakdown(secs, "all"),
    breakdown([s for s in secs if (s["target"], s["date"]) not in mass], "excluding mass-edit days"),
    breakdown([s for s in secs if s["kind"] == "modified"], "modified pages only"),
]
for kind in ("docs", "readme"):
    ids = {r["id"] for r in res if r["kind"] == kind}
    rows.append(breakdown([s for s in secs if s["target"] in ids], f"{kind} sources"))
table(rows, head)

# Concentration: is the version share carried by a few sources?
print("Per source (sources with any section):\n")
prow = []
for r in sorted(ok, key=lambda r: -r["sections"]):
    if not r["sections"]:
        continue
    ss = [s for s in secs if s["target"] == r["id"]]
    sub = [s for s in ss if s["noise"] == "substantive"]
    vp = [s for s in sub if s["attribution"]["by"] in PUB]
    chars = sum(s["chars"] for s in vp)
    prow.append([r["id"], r.get("latest") or "–", r["commitsInWindow"], r["activeDays"], sum(r["events"].values()), len(ss), len(sub), len(vp), chars, ", ".join(r.get("massEditDays", [])) or "–"])
table(prow, ["source", "latest", "commits", "active days", "events", "sections", "substantive", "versioned substantive", "chars to extract", "mass-edit days"])

vp_all = [s for s in secs if s["noise"] == "substantive" and s["attribution"]["by"] in PUB]
chars = sum(s["chars"] for s in vp_all)
print(f"Extraction input over {DAYS} days for the whole sample: {len(vp_all)} sections, {chars} characters (≈ {chars // 4} tokens), ≈ {chars // 4 // DAYS} tokens a day.\n")

if show_markers:
    print("### Every marker attribution (precision review)\n")
    for s in secs:
        if s["attribution"]["by"] == "marker":
            print(f"- {s['target']} {s['date']} `{s['file']}` {' > '.join(s['path'])} → {s['attribution']['version']} from “{s['attribution']['marker']}” ({s['noise']}, {s['status']})")
    print()
    print("### Guide attributions by source and version\n")
    g = collections.Counter((s["target"], s["file"], s["attribution"]["version"]) for s in secs if s["attribution"]["by"] == "guide")
    for (t, f, v), n in g.most_common():
        print(f"- {t} `{f}` → {v}: {n} sections")
    print()

if wb:
    print(f"## Wayback replay: {len(wb['results'])} sites, {wb['days']} days\n")
    wr = wb["results"]
    ws = wb["sections"]
    pairs = sum(r["pairs"] for r in wr)
    same = sum(r["identicalText"] for r in wr)
    print(f"Sites with captures: {sum(1 for r in wr if r['captured'])}; errors: {sum(1 for r in wr if r.get('error'))}. Capture pairs whose bytes changed: {pairs}; of those, extracted text identical: {same} ({pct(same, pairs)}) — template or markup churn the extraction absorbs.\n")
    table([breakdown(ws, "all")], head)
    table([[r["site"], r.get("latest") or "–", r["captured"], r["changedPages"], r["sampled"], r["pairs"], r["identicalText"], r["sections"], r.get("error", "")] for r in wr], ["site", "latest", "pages captured", "changed", "sampled", "pairs", "identical text", "sections", "error"])
