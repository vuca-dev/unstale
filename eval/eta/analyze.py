"""Can central give a trustworthy completion range? Measured from the coverage service's job timeline.

    python3 -I analyze.py [timeline.jsonl] [--json out.json]

Input: `.store/central/onboarding/timeline.jsonl` (one line per saved job state; `service.ts`, `timeline`). No model
calls, no network. Pre-registered rule (vault: Onboarding DX - Gap Hypotheses, H6; eval/eta/README.md):

  A range may be shown only if, over at least 30 jobs that reached `monitoring`, an interval fitted on the earlier
  half (per-unit p10 and p90 times the job's planned units, plus the queue wait's p10 and p90) holds the actual
  duration of at least 80% of the later half. Otherwise the client shows observed progress only.
"""
import json
import os
import statistics
import sys
from datetime import datetime

DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".store", "central", "onboarding", "timeline.jsonl")


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def jobs(path):
    by = {}
    for line in open(path):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        by.setdefault(e["purl"], []).append(e)
    return {p: sorted(es, key=lambda e: e["at"]) for p, es in by.items()}


def units(events):
    """Per-unit durations from consecutive events: a release or docs page is the time until its counter moves."""
    rel, docs, waits = [], [], []
    queued_at = None
    for a, b in zip(events, events[1:]):
        dt = ts(b["at"]) - ts(a["at"])
        if a["state"] == "queued" and b["state"] != "queued":
            waits.append(ts(b["at"]) - (queued_at or ts(a["at"])))
            queued_at = None
        elif a["state"] == "queued" and queued_at is None:
            queued_at = ts(a["at"])
        if (b.get("releases_done") or 0) > (a.get("releases_done") or 0):
            rel.append(dt / (b["releases_done"] - (a.get("releases_done") or 0)))
        if (b.get("docs_done") or 0) > (a.get("docs_done") or 0):
            docs.append(dt / (b["docs_done"] - (a.get("docs_done") or 0)))
    return rel, docs, waits


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else DEFAULT
    out = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    js = jobs(path)
    done = {p: es for p, es in js.items() if es[-1]["state"] == "monitoring"}
    order = sorted(done, key=lambda p: done[p][0]["at"])
    rel, docs, waits = [], [], []
    for p in js:
        r, d, w = units(js[p])
        rel += r
        docs += d
        waits += w
    spread = {
        name: dict(n=len(xs), p50=pct(xs, 0.5), p80=pct(xs, 0.8), ratio=(pct(xs, 0.8) / pct(xs, 0.5)) if xs and pct(xs, 0.5) else None)
        for name, xs in (("release_s", rel), ("docs_page_s", docs), ("queue_wait_s", waits))
    }
    result = dict(timeline=path, jobs=len(js), completed=len(done), spread=spread, verdict="insufficient data (fewer than 30 completed jobs)")
    if len(order) >= 30:
        fit, test = order[: len(order) // 2], order[len(order) // 2:]
        fr, fd, fw = [], [], []
        for p in fit:
            r, d, w = units(done[p])
            fr += r
            fd += d
            fw += w
        held = 0
        for p in test:
            es = done[p]
            actual = ts(es[-1]["at"]) - ts(es[0]["at"])
            nr, nd = es[-1].get("releases_total") or 0, es[-1].get("docs_total") or 0
            lo = (pct(fr, 0.1) or 0) * nr + (pct(fd, 0.1) or 0) * nd + (pct(fw, 0.1) or 0)
            hi = (pct(fr, 0.9) or 0) * nr + (pct(fd, 0.9) or 0) * nd + (pct(fw, 0.9) or 0)
            held += lo <= actual <= hi
        share = held / len(test)
        result.update(held=held, tested=len(test), share=share, verdict="range allowed" if share >= 0.8 else "no range: observed progress only")
    print(json.dumps(result, indent=1))
    if out:
        json.dump(result, open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
