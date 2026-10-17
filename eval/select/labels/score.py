"""Label-field scorer (PREREG.md): reference = A/B agreement, else the adjudicator's value; candidates = raw label
answers per chunk, stored as the pipeline would store them (strings(): backticks dropped, per-field caps).

  python3 score.py table <run> [<run> ...]          # metrics per field ("g0" = slice 3b answers in items.json)
  python3 score.py compare <base run> <cand run>     # paired chunk bootstrap of the differences
  python3 score.py power                             # reference positives per field

Deterministic: same answers, same numbers (bootstrap seed 0).
"""
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out", "labels")
FIELDS = ["replaces", "requires", "prerequisites", "conditions"]
CAPS = {"terms": 12, "replaces": 4, "requires": 6, "conditions": 6}
BATCH = 20
STOP = set("a an the of to in on for and or with by is are be as at from that this it its if when only not no any all your you use using used can must should may will".split())


def load_items():
    with open(os.path.join(HERE, "items.json")) as f:
        return json.load(f)["chunks"]


def batch_ids(chunk):
    ids = []
    for i in range(0, len(chunk["records"]), BATCH):
        ids.append(re.sub(r"[^\w.@#+-]", "_", f"{chunk['doc']}#{chunk['ci']}.{i // BATCH}"))
    return ids


def first_json_object(text):
    """As codex.ts parseJson(text, "object"): strip a code fence, take the first {...} span, strict JSON."""
    if text is None:
        return None
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    m = re.search(r"\{[\s\S]*\}", t)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return v if isinstance(v, dict) else None


def strings(v, cap):
    """As extract.ts strings(): strings only, backticks dropped, trimmed, de-duplicated, capped."""
    out = []
    for x in v or []:
        if not isinstance(x, str):
            continue
        s = x.replace("`", "").strip()
        if s and s not in out and len(out) < cap:
            out.append(s)
    return out


def norm_id(x):
    s = str(x).strip().strip("`'\"").strip()
    s = re.sub(r"\(\s*\)$", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.lower()


def prereq_keys(v):
    out = []
    for p in v or []:
        if isinstance(p, dict) and p.get("name"):
            k = (str(p.get("ecosystem", "")).strip().lower(), str(p["name"]).strip().lower())
            if k not in out:
                out.append(k)
    return out


def content_words(s):
    return {w for w in re.findall(r"[a-z0-9][a-z0-9.+_-]*", str(s).lower()) if w not in STOP}


def jaccard(a, b):
    if not a and not b:
        return 0.0
    return len(a & b) / len(a | b)


def match_conditions(cand, ref, threshold=0.5):
    """Greedy one-to-one matching by content-word Jaccard >= threshold; returns the number of matched pairs."""
    pairs = []
    for i, c in enumerate(cand):
        for j, r in enumerate(ref):
            s = jaccard(content_words(c), content_words(r))
            if s >= threshold:
                pairs.append((-s, i, j))
    pairs.sort()
    used_c, used_r, n = set(), set(), 0
    for _, i, j in pairs:
        if i in used_c or j in used_r:
            continue
        used_c.add(i)
        used_r.add(j)
        n += 1
    return n


def field_values(field, labels):
    """The stored values of one field from one record's raw label answer."""
    labels = labels if isinstance(labels, dict) else {}
    v = labels.get(field)
    v = v if isinstance(v, list) else []
    if field == "prerequisites":
        return prereq_keys(v)
    vals = strings(v, CAPS[field])
    if field == "conditions":
        return vals
    out = []
    for x in vals:
        n = norm_id(x)
        if n and n not in out:
            out.append(n)
    return out


def counts(field, cand, ref):
    """(tp, fp, fn) items and (tp, fp, fn) presence for one record."""
    if field == "conditions":
        tp = match_conditions(cand, ref)
    else:
        tp = len(set(cand) & set(ref))
    item = (tp, len(cand) - tp, len(ref) - tp)
    pc, pr = bool(cand), bool(ref)
    pres = (int(pc and pr), int(pc and not pr), int(pr and not pc))
    return item, pres


def canon(field, v):
    if field == "prerequisites":
        return sorted(json.dumps(x, sort_keys=True) for x in (v if isinstance(v, list) else []))
    return sorted(str(x).strip().lower() for x in (v if isinstance(v, list) else []))


def load_reference(items):
    """{(chunk key, record id): {field: raw value}} and adjudication side-taking."""
    ref, side = {}, {"agree": 0, "A": 0, "B": 0, "other": 0, "missing": 0}
    for c in items:
        key = f"{c['doc']}#{c['ci']}"
        for bi, bid in enumerate(batch_ids(c)):
            paths = {L: os.path.join(OUT, "ref", L, f"{bid}.json") for L in ("A", "B", "ADJ")}
            A = json.load(open(paths["A"])) if os.path.exists(paths["A"]) else None
            B = json.load(open(paths["B"])) if os.path.exists(paths["B"]) else None
            ADJ = json.load(open(paths["ADJ"])) if os.path.exists(paths["ADJ"]) else {}
            for r in c["records"][bi * BATCH:(bi + 1) * BATCH]:
                rid = r["id"]
                if A is None or B is None:
                    side["missing"] += 1
                    continue
                rec = {"terms_A": (A.get(rid) or {}).get("terms"), "terms_B": (B.get(rid) or {}).get("terms")}
                for f in FIELDS:
                    a, b = (A.get(rid) or {}).get(f, []), (B.get(rid) or {}).get(f, [])
                    if canon(f, a) == canon(f, b):
                        rec[f] = a
                        side["agree"] += 1
                    elif f"{rid}/{f}" in ADJ:
                        v = ADJ[f"{rid}/{f}"]
                        rec[f] = v
                        cv = canon(f, v)
                        side["A" if cv == canon(f, a) else "B" if cv == canon(f, b) else "other"] += 1
                    else:
                        rec[f] = None
                        side["missing"] += 1
                ref[(key, rid)] = rec
    return ref, side


def load_answers(run, items):
    """{chunk key: parsed answer object or None}."""
    if run == "g0":
        return {f"{c['doc']}#{c['ci']}": first_json_object(c.get("baseline")) for c in items}
    with open(os.path.join(OUT, "runs", run, "answers.json")) as f:
        raw = json.load(f)
    return {k: first_json_object(v) for k, v in raw.items()}


def per_chunk(run, items, ref):
    """{chunk key: {field: [tp, fp, fn, ptp, pfp, pfn]}} plus terms tallies, over records with a settled reference."""
    ans = load_answers(run, items)
    out = {}
    for c in items:
        key = f"{c['doc']}#{c['ci']}"
        a = ans.get(key) or {}
        acc = {f: [0] * 6 for f in FIELDS}
        acc["terms"] = [0] * 4  # core hit, core total, loose hit, cand total
        for r in c["records"]:
            rr = ref.get((key, r["id"]))
            if rr is None:
                continue
            labels = a.get(r["id"]) if isinstance(a, dict) else None
            for f in FIELDS:
                if rr.get(f) is None:
                    continue
                item, pres = counts(f, field_values(f, labels), field_values(f, {f: rr[f]}))
                acc[f] = [x + y for x, y in zip(acc[f], item + pres)]
            intro = set(r.get("introduces") or [])
            cand_terms = {norm_id(t) for t in strings((labels or {}).get("terms") if isinstance(labels, dict) else [], 40) if t not in intro}
            ta = {norm_id(t) for t in strings(rr.get("terms_A"), 40)}
            tb = {norm_id(t) for t in strings(rr.get("terms_B"), 40)}
            core, union = ta & tb, ta | tb
            acc["terms"] = [acc["terms"][0] + len(cand_terms & core), acc["terms"][1] + len(core), acc["terms"][2] + len(cand_terms & union), acc["terms"][3] + len(cand_terms)]
        out[key] = acc
    return out


def ratio(n, d):
    return n / d if d else float("nan")


def metrics(acc_list):
    tot = {f: [0] * 6 for f in FIELDS}
    tot["terms"] = [0] * 4
    for acc in acc_list:
        for f in tot:
            tot[f] = [x + y for x, y in zip(tot[f], acc[f])]
    m = {}
    for f in FIELDS:
        tp, fp, fn, ptp, pfp, pfn = tot[f]
        m[f] = {"P": ratio(tp, tp + fp), "R": ratio(tp, tp + fn), "presP": ratio(ptp, ptp + pfp), "presR": ratio(ptp, ptp + pfn),
                "ref_items": tp + fn, "cand_items": tp + fp, "ref_records": ptp + pfn, "cand_records": ptp + pfp}
    t = tot["terms"]
    m["terms"] = {"core_R": ratio(t[0], t[1]), "loose_P": ratio(t[2], t[3]), "core": t[1], "cand": t[3]}
    return m


KEYS = [(f, k) for f in FIELDS for k in ("R", "P", "presR", "presP")] + [("terms", "core_R"), ("terms", "loose_P")]


def bootstrap(base, cand, n=2000, seed=0):
    keys = sorted(base)
    rng = random.Random(seed)
    point_b, point_c = metrics([base[k] for k in keys]), metrics([cand[k] for k in keys])
    diffs = {fk: [] for fk in KEYS}
    for _ in range(n):
        s = [keys[rng.randrange(len(keys))] for _ in keys]
        mb, mc = metrics([base[k] for k in s]), metrics([cand[k] for k in s])
        for f, k in KEYS:
            d = mc[f][k] - mb[f][k]
            if d == d:
                diffs[(f, k)].append(d)
    out = {}
    for f, k in KEYS:
        ds = sorted(diffs[(f, k)])
        lo = ds[int(0.025 * len(ds))] if ds else float("nan")
        hi = ds[min(len(ds) - 1, int(0.975 * len(ds)))] if ds else float("nan")
        out[f"{f}.{k}"] = {"base": point_b[f][k], "cand": point_c[f][k], "diff": point_c[f][k] - point_b[f][k], "ci": [lo, hi]}
    return out


def main():
    items = load_items()
    ref, side = load_reference(items)
    cmd = sys.argv[1]
    if cmd == "power":
        m = metrics([per_chunk("g0", items, ref)[k] for k in sorted({f"{c['doc']}#{c['ci']}" for c in items})])
        print(json.dumps({"records_with_reference": len(ref), "adjudication": side,
                          "positives": {f: {"records": m[f]["ref_records"], "items": m[f]["ref_items"]} for f in FIELDS},
                          "by_set": {s: {f: metrics([per_chunk("g0", [c for c in items if c["set"] == s], ref)[k] for k in per_chunk("g0", [c for c in items if c["set"] == s], ref)])[f]["ref_records"] for f in FIELDS} for s in ("H1", "H2")}}, indent=1))
    elif cmd == "table":
        res = {}
        for run in sys.argv[2:]:
            pc = per_chunk(run, items, ref)
            res[run] = {"all": metrics(list(pc.values()))}
            for s in ("H1", "H2"):
                res[run][s] = metrics([pc[f"{c['doc']}#{c['ci']}"] for c in items if c["set"] == s])
        print(json.dumps(res, indent=1))
    elif cmd == "compare":
        b, c = per_chunk(sys.argv[2], items, ref), per_chunk(sys.argv[3], items, ref)
        print(json.dumps(bootstrap(b, c), indent=1))


if __name__ == "__main__":
    main()
