"""Scorers for the technology-disjoint held-out sets (eval/select/holdout/README.md). Standard library only; no model calls.

    python3 score.py extraction PRED --labels ADJ.json [--notes notes.json]
        PRED: an incoming.json (list of records with technology, version and quote; a `note_file` field, or a key
        tagged `+guide`, picks between a guide and the release notes of one version), a catalog directory
        (v1/tech/*.json shards; each evidence quote is attributed to a note by its URL), or {note_file: [quote, ...]}.
        ADJ:  {note_file: [{id, group, anchors: [..], change_type, breaking, required?, unsure?}]} (adjudicated; a
        labeler file {note_file: [{anchor, ...}]} also loads, one group per item). Recall is per group: a group is
        recalled when a record's quote overlaps any anchor of any of its items (one record recalls at most one group).
        Precision: a record is credited when it overlaps an anchor in its note, each group crediting at most as many
        records as it has items. --notes selects the set: the first held-out set (default, extraction/notes.json) or
        the majors set (../holdout-majors/extraction/notes.json), whose labels carry `required` and whose notes carry
        `kind` (guide | major_notes); required-group recall is then a headline.
    python3 score.py classify PRED.json --labels ADJ.json [--records records.json]
        PRED, ADJ: {id: {breaking, benefit, change_type, actionable}}; PRED may give `surface` instead of `actionable`
        (actionable = surface != runtime_internal).
    python3 score.py compare A B --labels ADJ.json [--kind extraction|classify] [--notes notes.json] [--unit auto|note|section|group]
        Paired McNemar exact test and a 2,000-resample paired bootstrap CI of B - A for each headline metric.
        Extraction resampling unit: `note` (the first set: clusters are notes), `section` (the majors set, PREREG
        Addendum: clusters are top-level sections of each document; a group belongs to the section holding its first
        anchor, a record to the section of the group it is credited to or else of the line it best matches) or
        `group` (no clustering). `auto` (default): `section` when the manifest's notes carry `kind`, else `note`.
"""
import argparse
import difflib
import gzip
import json
import math
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NOTES = os.path.join(HERE, "extraction", "notes.json")
RECORDS = os.path.join(HERE, "classify", "records.json")
MIN_CONTAIN = 25
MIN_RATIO = 0.8
BOOT = 2000
SEED = 20261016

def rj(path):
    with open(path, encoding="utf8") as fh:
        return json.load(fh)


def classify_ref(path):
    """A classify reference without its non-record keys (adjudicated.json also holds an `overrides` list)."""
    return {k: v for k, v in rj(path).items() if isinstance(v, dict)}

# ---------------------------------------------------------------- matching


def norm(q):
    q = re.sub(r"\(?#\d+\)?|[`*_\[\]]", " ", (q or "").lower())
    q = re.sub(r"^\s*(?:[-+*]|\d+\.)\s+", "", q)
    return re.sub(r"\s+", " ", q).strip()


def overlaps(quote, anchor):
    """A record quote and a labelled anchor are the same evidence: the shorter (normalised) is contained in the longer
    and is at least MIN_CONTAIN characters, or the two are similar (ratio >= MIN_RATIO)."""
    a, b = norm(quote), norm(anchor)
    if not a or not b:
        return False
    s, l = (a, b) if len(a) <= len(b) else (b, a)
    if len(s) >= MIN_CONTAIN and s in l:
        return True
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio() >= MIN_RATIO


def max_matching(edges, n_left):
    """Maximum bipartite matching (Kuhn). edges[i] = right nodes of left node i. Returns {left: right}."""
    match_r = {}

    def augment(u, seen):
        for v in edges[u]:
            if v in seen:
                continue
            seen.add(v)
            if v not in match_r or augment(match_r[v], seen):
                match_r[v] = u
                return True
        return False

    sys.setrecursionlimit(max(1000, 4 * n_left + 100))
    for u in range(n_left):
        augment(u, set())
    return {u: v for v, u in match_r.items()}


def note_groups(items):
    """Labelled items of one note -> groups in first-seen order: [{group, items, anchors, size, breaking, unsure}].
    Adjudicated schema: {id, group, anchors: [..], change_type, breaking, unsure?}. The single-labeler schema
    ({anchor, ...}, no group) is accepted too: each item is its own group with one anchor."""
    out, by = [], {}
    for j, it in enumerate(items):
        g = it.get("group") or it.get("id") or "item%d" % j
        if g not in by:
            by[g] = {"group": g, "items": [], "anchors": []}
            out.append(by[g])
        by[g]["items"].append(it)
        for a in it.get("anchors") or [it.get("anchor")]:
            if a and a not in by[g]["anchors"]:
                by[g]["anchors"].append(a)
    for g in out:
        g["size"] = len(g["items"])
        g["breaking"] = any(bool(it.get("breaking")) for it in g["items"])
        g["unsure"] = all(bool(it.get("unsure")) for it in g["items"])
        req = [required_of(it) for it in g["items"]]
        # required: some item is (or may be) a required migration step; required_sure: some item is, without doubt.
        g["required"] = any(r in (True, "unsure") for r in req)
        g["required_sure"] = any(r is True and not it.get("unsure") for r, it in zip(req, g["items"]))
    return out


def required_of(it):
    """An item's `required` as True, False, "unsure" or None (absent). Accepts booleans and yes/no/true/false/unsure."""
    v = it.get("required")
    if isinstance(v, str):
        v = {"true": True, "yes": True, "false": False, "no": False, "unsure": "unsure"}.get(v.strip().lower())
    return v


def match_note(quotes, groups):
    """Match record quotes to labelled groups in one note. An edge exists when the quote overlaps ANY anchor of the
    group. Returns (recall, precision): recall = {record idx: group idx} with each group taking at most one record
    (a maximum matching, so one record recalls at most one group and a whole-note quote cannot sweep them all);
    precision = {record idx: group idx} with each group taking at most as many records as it has items (duplicates
    and one-record-per-line beyond that are not credited)."""
    edges = [[k for k, g in enumerate(groups) if any(overlaps(q, a) for a in g["anchors"])] for q in quotes]
    recall = max_matching(edges, len(quotes))
    slots = [(k, s) for k, g in enumerate(groups) for s in range(g["size"])]
    slot_of = {}
    for n, (k, _) in enumerate(slots):
        slot_of.setdefault(k, []).append(n)
    prec = max_matching([[n for k in e for n in slot_of[k]] for e in edges], len(quotes))
    return recall, {i: slots[n][0] for i, n in prec.items()}

# ---------------------------------------------------------------- extraction


def load_manifest(path=NOTES):
    m = rj(path)
    return {n["note_file"]: n for n in m["notes"]}

# ---------------------------------------------------------------- sections (PREREG majors, §3 and Addendum)

HEADING = re.compile(r"^(#{1,6})[ \t]+\S")
FENCE = re.compile(r"^\s*(```|~~~)")


def heading_lines(text):
    """[(line index, depth)] of ATX headings outside fenced code blocks (a `#` comment in a code sample is not one)."""
    out, fence = [], None
    for i, line in enumerate(text.split("\n")):
        m = FENCE.match(line)
        if m:
            fence = None if fence == m.group(1) else (fence or m.group(1))
            continue
        if fence is None:
            h = HEADING.match(line)
            if h:
                out.append((i, len(h.group(1))))
    return out


def section_starts(text):
    """Line indices where each top-level section starts. Top level: the highest heading level occurring at least twice
    (else the highest present). Section 0 is the text before the first top-level heading (possibly empty)."""
    hs = heading_lines(text)
    if not hs:
        return [0]
    depths = [d for _, d in hs]
    twice = [d for d in set(depths) if depths.count(d) >= 2]
    top = min(twice) if twice else min(depths)
    return [0] + [i for i, d in hs if d == top and i > 0]


def line_section(starts, line):
    k = 0
    for n, s in enumerate(starts):
        if s <= line:
            k = n
    return k


def note_texts(notes_path, manifest):
    """{note_file: text or None}, read from the `notes/` directory next to the manifest."""
    d = os.path.join(os.path.dirname(os.path.abspath(notes_path)), "notes")
    out = {}
    for f in manifest:
        p = os.path.join(d, f)
        if os.path.exists(p):
            with open(p, encoding="utf8") as fh:
                out[f] = fh.read()
        else:
            out[f] = None
    return out


def locate(quote, lines):
    """Index of the line a quote comes from: the first containing line (verbatim, then normalised), else the most
    similar line. None for an empty quote or note."""
    if not quote or not lines:
        return None
    for i, l in enumerate(lines):
        if quote in l:
            return i
    q = norm(quote)
    nl = [norm(l) for l in lines]
    for i, l in enumerate(nl):
        if l and len(min(q, l, key=len)) >= MIN_CONTAIN and (q in l or l in q):
            return i
    best, bi = -1.0, None
    for i, l in enumerate(nl):
        if not l:
            continue
        sm = difflib.SequenceMatcher(None, q, l, autojunk=False)
        if sm.real_quick_ratio() <= best or sm.quick_ratio() <= best:
            continue
        r = sm.ratio()
        if r > best:
            best, bi = r, i
    return bi


class Sections:
    """Section of each group and record of one note (Addendum: a group belongs to the section of its first anchor)."""

    def __init__(self, text):
        self.lines = text.split("\n") if text else []
        self.starts = section_starts(text) if text else [0]

    def of_quote(self, quote):
        i = locate(quote, self.lines)
        return 0 if i is None else line_section(self.starts, i)


def load_catalog_records(cat):
    out = []
    tdir = os.path.join(cat, "v1", "tech")
    for f in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        for s in rj(os.path.join(tdir, f)).get("shards", []):
            path = s["path"] if s["path"].startswith("v1/") else "v1/" + s["path"]
            with gzip.open(os.path.join(cat, path), "rt") as fh:
                for line in fh:
                    r = json.loads(line)
                    if r.get("status", "active") == "active":
                        out.append(r)
    return out


def tech_key(t):
    return (t or "").lower().replace("@", "").replace("/", "-").lstrip("-")


def record_kind(r):
    """guide or major_notes for an incoming record (its `kind`, or a `+guide` tag in its key)."""
    k = (r.get("kind") or "").lower()
    if k in ("guide", "upgrade_guide") or "+guide" in (r.get("key") or ""):
        return "guide"
    return "major_notes"


def note_for(by_tv, manifest, tech, version, kind):
    fs = by_tv.get((tech_key(tech), version), [])
    if len(fs) <= 1:
        return fs[0] if fs else None
    k = [f for f in fs if manifest[f].get("kind") == kind]
    return k[0] if k else None


def predictions_by_note(path, manifest):
    """{note_file: [quote, ...]} for every note in the manifest; a note with no prediction gets [] (a recall miss)."""
    by = {f: [] for f in manifest}
    by_url = {}
    for f, n in manifest.items():
        by_url.setdefault(n["url"], []).append(f)
    by_tv = {}
    for f, n in manifest.items():
        for t in {n["technology"], n.get("name") or n["technology"]}:
            by_tv.setdefault((tech_key(t), n["version"]), [])
            if f not in by_tv[(tech_key(t), n["version"])]:
                by_tv[(tech_key(t), n["version"])].append(f)
    if os.path.isdir(path):
        for r in load_catalog_records(path):
            for e in r.get("evidence") or []:
                for f in by_url.get(e.get("url"), []):
                    by[f].append(e.get("quote") or "")
        return by
    data = rj(path)
    if isinstance(data, dict):
        for f, qs in data.items():
            if f in by:
                by[f].extend(q if isinstance(q, str) else (q.get("quote") or q.get("evidence") or "") for q in qs)
        return by
    for r in data:
        kind = record_kind(r)
        f = r.get("note_file") if r.get("note_file") in by else note_for(by_tv, manifest, r.get("technology"), r.get("version"), kind)
        if f is None and r.get("key"):
            t, rest = r["key"].rsplit("@", 1) if not r["key"].startswith("@") else ("@" + r["key"][1:].split("@", 1)[0], r["key"][1:].split("@", 1)[1])
            f = note_for(by_tv, manifest, t, re.split(r"[#+]", rest)[0], kind)
        if f is not None:
            by[f].append(r.get("quote") or r.get("evidence") or "")
    return by


def extraction_rows(pred, labels, manifest, texts=None):
    """Per labelled group: (note, group, recalled); per record: (note, credited). The unit of recall is the group, so
    splitting one bullet into several items neither rewards nor punishes a model. With `texts` ({note_file: text}),
    every row also carries `section` ("<note>#<k>", the top-level section; see Sections)."""
    groups, recs = [], []
    for f, n in manifest.items():
        gs = note_groups(labels.get(f, []))
        qs = pred.get(f, [])
        rec, prec = match_note(qs, gs)
        hit = set(rec.values())
        meta = note_meta(f, n)
        sec = Sections(texts.get(f)) if texts is not None else None
        gsec = [sec.of_quote(g["anchors"][0] if g["anchors"] else "") for g in gs] if sec else []
        for k, g in enumerate(gs):
            row = dict(meta, group=g["group"], items=g["size"], breaking=g["breaking"], unsure=g["unsure"],
                       required=g["required"], required_sure=g["required_sure"], hit=k in hit)
            if sec:
                row["section"] = "%s#%d" % (f, gsec[k])
            groups.append(row)
        for i in range(len(qs)):
            row = dict(meta, hit=i in prec)
            if sec:
                row["section"] = "%s#%d" % (f, gsec[prec[i]] if i in prec else sec.of_quote(qs[i]))
            recs.append(row)
    return groups, recs


def note_meta(f, n):
    """Breakdown keys of a note. The first set has structure and length; the majors set has kind instead."""
    return {"note": f, "tech": n["technology"], "eco": n["ecosystem"], "structure": n.get("structure", "-"),
            "length": n.get("length", "-"), "kind": n.get("kind", "-")}


def frac(xs, key="hit"):
    return (sum(x[key] for x in xs), len(xs))


def fmt(k, n):
    return "%d/%d (%.1f%%)" % (k, n, 100 * k / n) if n else "0/0 (-)"


def macro(xs, key="hit"):
    """Mean over notes of the per-note rate (notes with no row are skipped). Returns (mean, notes)."""
    by = {}
    for x in xs:
        by.setdefault(x["note"], []).append(x[key])
    return (sum(sum(v) / len(v) for v in by.values()) / len(by), len(by)) if by else (float("nan"), 0)


def fmt_macro(m):
    return "%.1f%% over %d notes" % (100 * m[0], m[1]) if m[1] else "- (0 notes)"


def extraction(args):
    manifest = load_manifest(args.notes)
    labels = rj(args.labels)
    unknown = sorted(set(labels) - set(manifest))
    if unknown:
        print("warning: %d labelled notes not in the manifest: %s" % (len(unknown), unknown[:3]))
    unlabelled = sorted(set(manifest) - set(labels))
    if unlabelled:
        print("warning: %d notes have no labels (scored as zero groups): %s" % (len(unlabelled), unlabelled[:3]))
    pred = predictions_by_note(args.pred, manifest)
    groups, recs = extraction_rows(pred, labels, manifest)
    sure = [x for x in groups if not x["unsure"]]
    brk = [x for x in groups if x["breaking"]]
    req = [x for x in groups if x["required"]]
    req_sure = [x for x in groups if x["required_sure"]]
    has_req = any(required_of(it) is not None for items in labels.values() for it in items)
    print("notes %d | groups %d (items %d; %d unsure groups; %d required, %d required excl. unsure) | records %d | records per note %.2f" % (
        len(manifest), len(groups), sum(x["items"] for x in groups), len(groups) - len(sure), len(req), len(req_sure), len(recs), len(recs) / max(1, len(manifest))))
    if has_req:
        print("REQUIRED recall (groups) pooled %-20s macro per note %s" % (fmt(*frac(req)), fmt_macro(macro(req))))
        print("  required excl. unsure  pooled %-20s macro per note %s" % (fmt(*frac(req_sure)), fmt_macro(macro(req_sure))))
    print("recall (groups)          pooled %-20s macro per note %s" % (fmt(*frac(groups)), fmt_macro(macro(groups))))
    print("  excluding unsure       pooled %-20s macro per note %s" % (fmt(*frac(sure)), fmt_macro(macro(sure))))
    print("  breaking groups        pooled %-20s macro per note %s" % (fmt(*frac(brk)), fmt_macro(macro(brk))))
    print("  unsure groups (report) pooled %s" % fmt(*frac([x for x in groups if x["unsure"]])))
    print("precision                pooled %-20s macro per note %s  (credited records / records; a group credits at most its item count)" % (
        fmt(*frac(recs)), fmt_macro(macro(recs))))
    slices = [("technology", "tech"), ("ecosystem", "eco"), ("kind", "kind"), ("structure", "structure"), ("length", "length")]
    for name, key in slices:
        vals = sorted({x[key] for x in groups} | {x[key] for x in recs} | {note_meta(f, n)[key] for f, n in manifest.items()})
        if vals == ["-"]:
            continue
        print("by %s:" % name)
        for v in vals:
            gs = [x for x in groups if x[key] == v]
            rs = [x for x in recs if x[key] == v]
            notes = sum(1 for f, n in manifest.items() if note_meta(f, n)[key] == v)
            print("  %-22s %srecall %-18s macro %-6s excl-unsure %-18s breaking %-16s precision %-18s records/note %.2f" % (
                v, ("required %-16s " % fmt(*frac([x for x in gs if x["required"]]))) if has_req else "",
                fmt(*frac(gs)), "%.1f%%" % (100 * macro(gs)[0]) if gs else "-", fmt(*frac([x for x in gs if not x["unsure"]])),
                fmt(*frac([x for x in gs if x["breaking"]])), fmt(*frac(rs)), len(rs) / max(1, notes)))
    if has_req and any(x["kind"] != "-" for x in groups):
        print("by technology x kind (required recall | group recall | precision):")
        for t in sorted({x["tech"] for x in groups}):
            for k in sorted({x["kind"] for x in groups if x["tech"] == t}):
                gs = [x for x in groups if x["tech"] == t and x["kind"] == k]
                rs = [x for x in recs if x["tech"] == t and x["kind"] == k]
                print("  %-22s %-12s %-18s | %-18s | %s" % (t, k, fmt(*frac([x for x in gs if x["required"]])), fmt(*frac(gs)), fmt(*frac(rs))))
    return groups, recs

# ---------------------------------------------------------------- classify

BENEFITS = ("security", "correctness", "performance", "cost", "maintainability")
OBLIGATION = ("removal", "deprecation")


def norm_label(v):
    if v is None:
        return None
    out = dict(v)
    b = out.get("benefit")
    if isinstance(b, str):
        b = [b]
    out["benefit"] = sorted(set(b or ["none"]) - {"other"}) or ["none"]
    if set(out["benefit"]) - {"none"}:
        out["benefit"] = sorted(set(out["benefit"]) - {"none"})
    if "actionable" not in out and "surface" in out:
        out["actionable"] = out["surface"] != "runtime_internal"
    return out


def classify_vectors(pred, ref):
    """Per reference id, the per-metric outcomes. Each metric: list of (id, in_denominator, correct, predicted_positive,
    reference_positive). A missing prediction (or field) is wrong: for a binary label it predicts the opposite of the
    reference."""
    rows = {}
    for i, r in ref.items():
        p = norm_label(pred.get(i))
        r = norm_label(r)

        def binary(field, ref_val, pred_val):
            if pred_val is None:
                pred_val = not ref_val
            return {"ref": bool(ref_val), "pred": bool(pred_val)}

        some_r = r["benefit"] != ["none"]
        some_p = None if p is None or p.get("benefit") is None else p["benefit"] != ["none"]
        row = {
            "breaking": binary("breaking", r["breaking"], None if p is None else p.get("breaking")),
            "benefit_any": binary("benefit", some_r, some_p),
            "actionable": binary("actionable", r["actionable"], None if p is None else p.get("actionable")),
            "benefit_exact": p is not None and p.get("benefit") is not None and set(p["benefit"]) == set(r["benefit"]),
            "change_type": p is not None and p.get("change_type") == r["change_type"],
            "ct_ref": r["change_type"],
            "ct_pred": None if p is None else p.get("change_type"),
        }
        for b in BENEFITS:
            pb = None if p is None or p.get("benefit") is None else b in p["benefit"]
            row["benefit:" + b] = binary(b, b in r["benefit"], pb)
        rows[i] = row
    return rows


def prf(rows, key, ids=None):
    xs = [rows[i][key] for i in (ids if ids is not None else rows)]
    tp = sum(x["ref"] and x["pred"] for x in xs)
    fp = sum(not x["ref"] and x["pred"] for x in xs)
    fn = sum(x["ref"] and not x["pred"] for x in xs)
    acc = sum(x["ref"] == x["pred"] for x in xs)
    p = tp / (tp + fp) if tp + fp else float("nan")
    r = tp / (tp + fn) if tp + fn else float("nan")
    f = 2 * p * r / (p + r) if tp else 0.0
    return {"n": len(xs), "pos": tp + fn, "tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f, "accuracy": acc / len(xs) if xs else float("nan")}


def show(name, m):
    pc = lambda v: "-" if v != v else "%.1f%%" % (100 * v)
    print("  %-26s recall %6s (%d/%d)  precision %6s  F1 %6s  accuracy %6s  [n %d]" % (
        name, pc(m["recall"]), m["tp"], m["pos"], pc(m["precision"]), pc(m["f1"]), pc(m["accuracy"]), m["n"]))


def classify(args):
    pred = rj(args.pred)
    ref = classify_ref(args.labels)
    meta = {r["id"]: r for r in rj(args.records)["records"]} if os.path.exists(args.records) else {}
    missing = [i for i in ref if i not in pred]
    rows = classify_vectors(pred, ref)
    print("reference %d | predicted %d | missing %d (counted wrong)" % (len(ref), len(ref) - len(missing), len(missing)))
    show("breaking", prf(rows, "breaking"))
    for eco in sorted({m.get("ecosystem") for m in meta.values()} - {None}):
        ids = [i for i in rows if meta.get(i, {}).get("ecosystem") == eco]
        show("  breaking, " + eco, prf(rows, "breaking", ids))
    for t in sorted({m.get("technology") for m in meta.values()} - {None}):
        ids = [i for i in rows if meta.get(i, {}).get("technology") == t]
        show("  breaking, " + t, prf(rows, "breaking", ids))
    show("benefit vs none", prf(rows, "benefit_any"))
    ex = sum(r["benefit_exact"] for r in rows.values())
    print("  %-26s %s" % ("benefit identical set", fmt(ex, len(rows))))
    for b in BENEFITS:
        show("  benefit " + b, prf(rows, "benefit:" + b))
    ct = sum(r["change_type"] for r in rows.values())
    print("  %-26s %s" % ("change_type accuracy", fmt(ct, len(rows))))
    obl = [r for r in rows.values() if r["ct_ref"] in OBLIGATION]
    print("  %-26s exact %s | as an obligation (removal or deprecation) %s" % (
        "removal+deprecation recall", fmt(sum(r["ct_pred"] == r["ct_ref"] for r in obl), len(obl)), fmt(sum(r["ct_pred"] in OBLIGATION for r in obl), len(obl))))
    show("actionable (yes)", prf(rows, "actionable"))
    if meta:
        for s in sorted({m.get("stratum") for m in meta.values()} - {None}):
            ids = [i for i in rows if meta.get(i, {}).get("stratum") == s]
            print("  stratum %s: breaking accuracy %.1f%%, change_type accuracy %.1f%% [n %d]" % (
                s, 100 * prf(rows, "breaking", ids)["accuracy"], 100 * sum(rows[i]["change_type"] for i in ids) / max(1, len(ids)), len(ids)))
    return rows

# ---------------------------------------------------------------- compare


def mcnemar_exact(b, c):
    """Two-sided exact McNemar p (binomial on the discordant pairs)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def paired(name, ids, ca, cb, metric, rng, clusters=None):
    """ca, cb: per-id correctness (bool) for McNemar; metric(ids, side) the metric on a resample.
    clusters: {id: cluster} for a cluster bootstrap (extraction: items within a note)."""
    b = sum(ca[i] and not cb[i] for i in ids)
    c = sum(cb[i] and not ca[i] for i in ids)
    p = mcnemar_exact(b, c)
    base = metric(ids, "b") - metric(ids, "a")
    if clusters:
        groups = {}
        for i in ids:
            groups.setdefault(clusters[i], []).append(i)
        keys = sorted(groups)
    diffs = []
    for _ in range(BOOT):
        if clusters:
            s = [i for k in (rng.choice(keys) for _ in keys) for i in groups[k]]
        else:
            s = [rng.choice(ids) for _ in ids]
        d = metric(s, "b") - metric(s, "a")
        if d == d:
            diffs.append(d)
    diffs.sort()
    lo, hi = (diffs[int(0.025 * len(diffs))], diffs[min(len(diffs) - 1, int(0.975 * len(diffs)))]) if diffs else (float("nan"), float("nan"))
    print("  %-30s A %6.1f%%  B %6.1f%%  diff %+6.1f pts  95%% CI [%+.1f, %+.1f]  McNemar b=%d c=%d p=%.4f  [n %d]" % (
        name, 100 * metric(ids, "a"), 100 * metric(ids, "b"), 100 * base, 100 * lo, 100 * hi, b, c, p, len(ids)))
    return {"diff": base, "ci": (lo, hi), "p": p, "b": b, "c": c}


class Result(dict):
    """compare()'s per-metric results ({name: {diff, ci, p, b, c}}); extraction also sets .unit and .precision."""
    unit = None
    precision = None


def resample_unit(unit, manifest):
    """The extraction bootstrap's resampling unit. auto: top-level sections for the majors set (its notes carry `kind`,
    PREREG Addendum), notes for the first set."""
    if unit in (None, "auto"):
        return "section" if any(n.get("kind") for n in manifest.values()) else "note"
    return unit


def compare(args):
    labels = rj(args.labels)
    kind = args.kind or ("extraction" if all(isinstance(v, list) for v in labels.values()) else "classify")
    if kind == "classify":
        labels = classify_ref(args.labels)
    rng = random.Random(SEED)
    out = {}
    if kind == "extraction":
        manifest = load_manifest(args.notes)
        unit = resample_unit(getattr(args, "unit", None), manifest)
        texts = note_texts(args.notes, manifest) if unit == "section" else None
        if texts is not None and any(t is None for t in texts.values()):
            print("warning: no text for %s; such a note is one section" % sorted(f for f, t in texts.items() if t is None)[:3])
        ia, ra = extraction_rows(predictions_by_note(args.a, manifest), labels, manifest, texts)
        ib, rb = extraction_rows(predictions_by_note(args.b, manifest), labels, manifest, texts)
        ids = list(range(len(ia)))
        ckey = {"note": "note", "section": "section"}.get(unit)
        clusters = {i: ia[i][ckey] for i in ids} if ckey else None
        size = {}
        for i in ids:
            size[ia[i]["note"]] = size.get(ia[i]["note"], 0) + 1
        rate = lambda xs: sum(xs) / len(xs) if xs else float("nan")
        side = {"a": ia, "b": ib}

        def macro_rate(s, k):
            # Mean of per-note recall, each note weighted by how many of its groups the resample drew (relative to its
            # size): a note drawn twice counts twice; under section resampling, a note partly drawn counts in part.
            c, h = {}, {}
            for i in s:
                n = ia[i]["note"]
                c[n] = c.get(n, 0) + 1
                h[n] = h.get(n, 0) + side[k][i]["hit"]
            w = {n: c[n] / size[n] for n in c}
            return sum(w[n] * h[n] / c[n] for n in c) / sum(w.values()) if c else float("nan")

        n_clusters = len(set(clusters.values())) if clusters else len(ids)
        print("extraction: %d groups in %d notes (%s)" % (len(ids), len(manifest), {
            "note": "cluster bootstrap by note", "group": "bootstrap by group, unclustered",
            "section": "cluster bootstrap by top-level section: %d sections hold groups" % n_clusters}[unit]))
        for name, sel, metric in (
                ("recall, required groups", lambda x: x["required"], None),
                ("recall, required excl. unsure", lambda x: x["required_sure"], None),
                ("recall", lambda x: True, None), ("recall, excluding unsure", lambda x: not x["unsure"], None),
                ("recall, macro per note", lambda x: True, macro_rate), ("recall, breaking groups", lambda x: x["breaking"], None),
                ("recall, npm", lambda x: x["eco"] == "npm", None), ("recall, pypi", lambda x: x["eco"] == "pypi", None),
                ("recall, guides", lambda x: x["kind"] == "guide", None), ("recall, major notes", lambda x: x["kind"] == "major_notes", None)):
            sub = [i for i in ids if sel(ia[i])]
            if not sub:
                continue
            out[name] = paired(name, sub, {i: ia[i]["hit"] for i in sub}, {i: ib[i]["hit"] for i in sub},
                               metric or (lambda s, k: rate([side[k][i]["hit"] for i in s])), rng, clusters)
        # Precision has a different record set per side: bootstrap only, resampling the same clusters as recall
        # (notes, or sections: every section of every note, including those holding records but no group).
        recs = {"a": ra, "b": rb}
        pkey = "section" if unit == "section" else "note"
        units = sorted({r[pkey] for r in ra + rb} | ({x[pkey] for x in ia} if unit == "section" else set(manifest)))
        def prec(ns, k):
            idx = {}
            for n in ns:
                idx[n] = idx.get(n, 0) + 1
            hit = sum(r["hit"] * idx.get(r[pkey], 0) for r in recs[k])
            tot = sum(idx.get(r[pkey], 0) for r in recs[k])
            return hit / tot if tot else float("nan")
        base = prec(units, "b") - prec(units, "a")
        diffs = sorted(d for d in (prec(s, "b") - prec(s, "a") for s in ([rng.choice(units) for _ in units] for _ in range(BOOT))) if d == d)
        lo, hi = (diffs[int(0.025 * len(diffs))], diffs[min(len(diffs) - 1, int(0.975 * len(diffs)))]) if diffs else (float("nan"), float("nan"))
        print("  %-30s A %6.1f%%  B %6.1f%%  diff %+6.1f pts  95%% CI [%+.1f, %+.1f]  (bootstrap only, by %s)" % (
            "precision", 100 * prec(units, "a"), 100 * prec(units, "b"), 100 * base, 100 * lo, 100 * hi, pkey))
        out = Result(out)
        out.unit, out.precision = unit, {"diff": base, "ci": (lo, hi)}
        return out
    pa, pb = rj(args.a), rj(args.b)
    va, vb = classify_vectors(pa, labels), classify_vectors(pb, labels)
    ids = sorted(labels)
    side = {"a": va, "b": vb}
    print("classify: %d records" % len(ids))

    def rec_metric(key, sel):
        def m(s, k):
            xs = [side[k][i][key] for i in s if sel(side["a"][i][key])]
            return sum(x["pred"] for x in xs) / len(xs) if xs else float("nan")
        return m

    def acc_metric(key):
        def m(s, k):
            xs = [side[k][i][key] for i in s]
            return sum((x["pred"] == x["ref"]) if isinstance(x, dict) else bool(x) for x in xs) / len(xs) if xs else float("nan")
        return m

    def correct(v, key):
        x = v[key]
        return (x["pred"] == x["ref"]) if isinstance(x, dict) else bool(x)

    heads = [
        ("breaking recall", "breaking", lambda x: x["ref"], "recall"),
        ("breaking accuracy", "breaking", None, "acc"),
        ("benefit-vs-none recall", "benefit_any", lambda x: x["ref"], "recall"),
        ("benefit-vs-none accuracy", "benefit_any", None, "acc"),
        ("benefit identical set", "benefit_exact", None, "acc"),
        ("change_type accuracy", "change_type", None, "acc"),
        ("actionable recall (yes)", "actionable", lambda x: x["ref"], "recall"),
    ]
    for name, key, sel, kind_ in heads:
        sub = [i for i in ids if sel is None or sel(va[i][key])]
        out[name] = paired(name, sub, {i: correct(va[i], key) for i in sub}, {i: correct(vb[i], key) for i in sub},
                           rec_metric(key, sel) if kind_ == "recall" else acc_metric(key), rng)
    obl = [i for i in ids if va[i]["ct_ref"] in OBLIGATION]
    ob = lambda v, i: v[i]["ct_pred"] in OBLIGATION
    out["removal+deprecation recall"] = paired("removal+deprecation recall", obl, {i: ob(va, i) for i in obl}, {i: ob(vb, i) for i in obl},
                                               lambda s, k: sum(ob(side[k], i) for i in s) / len(s) if s else float("nan"), rng)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=("extraction", "classify", "compare"))
    ap.add_argument("pred")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--labels", required=True)
    ap.add_argument("--notes", default=NOTES)
    ap.add_argument("--records", default=RECORDS)
    ap.add_argument("--kind", choices=("extraction", "classify"))
    ap.add_argument("--unit", choices=("auto", "note", "section", "group"), default="auto",
                    help="extraction compare: bootstrap resampling unit (auto: section for the majors set, note otherwise)")
    a = ap.parse_args(argv)
    if a.cmd == "extraction":
        return extraction(a)
    if a.cmd == "classify":
        return classify(a)
    if not a.b:
        ap.error("compare needs two prediction files")
    a.a = a.pred
    return compare(a)


if __name__ == "__main__":
    main()
