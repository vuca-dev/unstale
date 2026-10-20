"""Slice 9 scorer (PREREG.md). No model calls; deterministic (fixed bootstrap seed).

    python3 eval/select/slice9/score9.py dev <arm> [<arm> ...]        # dev selection table
    python3 eval/select/slice9/score9.py heldout <arm>                # the one held-out look (H1 + H2)

Runs are read from out/slice9/runs/<arm>-<split>[-rep]/answers.json; B = base-<split>, Br = base-<split>-rep.
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEL = os.path.join(HERE, "..")
OUT9 = os.path.join(SEL, "out", "slice9")
OUT4 = os.path.join(SEL, "out", "slice4")
BENEFITS = ("security", "correctness", "performance", "cost", "maintainability")
OBLIG = ("removal", "deprecation")
FIELDS = ("change_type", "surface", "breaking") + tuple("benefit_" + b for b in BENEFITS)
BOOT = 2000


def rj(p):
    with open(p) as f:
        return json.load(f)


def run(name):
    return rj(os.path.join(OUT9, "runs", name, "answers.json"))


def meta(name):
    return rj(os.path.join(OUT9, "runs", name, "meta.json"))


def yes(c, q):
    return c["answers"][q]["probabilities"]["yes"] >= 0.5


def field_value(c, f):
    if c is None:
        return None
    return c["answers"][f]["choice"] if f in ("change_type", "surface") else yes(c, f)


# ---- metrics: each is (ids, side) -> value over per-record (pred, ref) tuples ----

def rec(pairs):
    pos = [p for p, r in pairs if r]
    return sum(pos) / len(pos) if pos else float("nan")


def prec(pairs):
    pp = [r for p, r in pairs if p]
    return sum(pp) / len(pp) if pp else float("nan")


def acc(pairs):
    return sum(pairs) / len(pairs) if pairs else float("nan")


def boot_ci(ids, clusters, f_a, f_b, seed):
    rng = random.Random(seed)
    groups = {}
    for i in ids:
        groups.setdefault(clusters[i], []).append(i)
    keys = sorted(groups)
    diffs = []
    for _ in range(BOOT):
        s = [i for k in (rng.choice(keys) for _ in keys) for i in groups[k]]
        d = f_b(s) - f_a(s)
        if d == d:
            diffs.append(d)
    diffs.sort()
    return diffs[int(0.025 * len(diffs))], diffs[min(len(diffs) - 1, int(0.975 * len(diffs)))]


def judge(name, ids, clusters, value, denom, B, Br, A, seed):
    """value(run, ids) -> metric; denom(B, ids) -> the metric's denominator under B."""
    b, br, a = value(B, ids), value(Br, ids), value(A, ids)
    da, dr = a - b, br - b
    tol = max(abs(dr), 1.0 / max(1, denom(B, ids)))
    lo, hi = boot_ci(ids, clusters, lambda s: value(B, s), lambda s: value(A, s), seed)
    ok = da >= -tol - 1e-12 and hi >= 0
    return {"metric": name, "B": b, "Br": br, "arm": a, "d_arm": da, "d_rep": dr, "tol": tol, "ci": [lo, hi], "n": denom(B, ids), "pass": ok}


def flips(A, B, ids, f):
    return sum(field_value(A.get(i), f) != field_value(B.get(i), f) for i in ids) / len(ids)


def show(rows):
    for r in rows:
        print("  %-34s B %5.1f  Br %5.1f  arm %5.1f | d_arm %+5.1f  tol %4.1f  CI [%+5.1f,%+5.1f]  n %3d  %s" % (
            r["metric"], 100 * r["B"], 100 * r["Br"], 100 * r["arm"], 100 * r["d_arm"], 100 * r["tol"],
            100 * r["ci"][0], 100 * r["ci"][1], r["n"], "ok" if r["pass"] else "FAIL"))


# ---- dev ----

def dev(arms):
    ref = rj(os.path.join(OUT4, "encoder", "dev-ref.json"))
    bref = {x["id"]: set(x["reference"]) - {"none"} for x in rj(os.path.join(SEL, "..", "sets", "benefit", "reference.json"))["items"]}
    item_of = ref["benefitItemOf"]
    B, Br = run("base-dev"), run("base-dev-rep")
    brk_ids = sorted(ref["breaking"])

    def brk_pairs(R, ids, kind):
        out = []
        for rid in ids:
            c, truth = R.get("breaking:" + rid), ref["breaking"][rid]
            p = yes(c, "breaking") if c else (not truth)
            out.append((p, truth))
        return out

    def ben_pred(R):
        items = {}
        for uid, item in item_of.items():
            c = R.get(uid)
            v = any(yes(c, "benefit_" + b) for b in BENEFITS) if c else None
            items[item] = None if v is None or items.get(item, False) is None else (items.get(item, False) or v)
        return items

    ben_ids = sorted(bref)
    cache = {}

    def ben_pairs(R, ids):
        k = id(R)
        if k not in cache:
            cache[k] = ben_pred(R)
        bp = cache[k]
        return [((not bool(bref[i])) if bp.get(i) is None else bp[i], bool(bref[i])) for i in ids]

    ident = {i: i for i in brk_ids + ben_ids}
    uids = sorted(B)
    out = {}
    for arm in arms:
        A = run(arm + "-dev")
        rows = [
            judge("breaking recall", brk_ids, ident, lambda R, s: rec(brk_pairs(R, s, 0)), lambda R, s: sum(ref["breaking"][i] for i in s), B, Br, A, 1),
            judge("breaking precision", brk_ids, ident, lambda R, s: prec(brk_pairs(R, s, 0)), lambda R, s: sum(p for p, _ in brk_pairs(R, s, 0)), B, Br, A, 2),
            judge("benefit-vs-none recall", ben_ids, ident, lambda R, s: rec(ben_pairs(R, s)), lambda R, s: sum(bool(bref[i]) for i in s), B, Br, A, 3),
            judge("benefit-vs-none precision", ben_ids, ident, lambda R, s: prec(ben_pairs(R, s)), lambda R, s: sum(p for p, _ in ben_pairs(R, s)), B, Br, A, 4),
        ]
        fl = []
        for f in FIELDS:
            fa, fr = flips(A, B, uids, f), flips(Br, B, uids, f)
            fl.append({"field": f, "arm": fa, "rep": fr, "pass": fa <= max(fr + 0.02, 1.5 * fr) + 1e-12})
        m = meta(arm + "-dev")
        mb = meta("base-dev")
        fails = sum(not r["pass"] for r in rows) + sum(not x["pass"] for x in fl)
        out[arm] = {"rows": rows, "flips": fl, "input_per_record": m["input_per_record"], "base_input_per_record": mb["input_per_record"], "failed_conditions": fails}
        print("== %s dev: %.0f Jev input tokens/record (B %.0f, %+.1f%%); failed conditions %d" % (
            arm, m["input_per_record"], mb["input_per_record"], 100 * (m["input_per_record"] / mb["input_per_record"] - 1), fails))
        show(rows)
        print("  flip rate vs B (arm / replicate): " + "  ".join("%s %.1f/%.1f%s" % (x["field"].replace("benefit_", "b:"), 100 * x["arm"], 100 * x["rep"], "" if x["pass"] else "!") for x in fl))
    with open(os.path.join(OUT9, "dev-report.json"), "w") as f:
        json.dump(out, f, indent=1)


# ---- held-out ----

def heldout(arm):
    labels = rj(os.path.join(OUT4, "adjudicated-records.json"))
    recs = {r["id"]: r for r in rj(os.path.join(SEL, "holdout", "classify", "records.json"))["records"]}
    h2 = {u["id"]: u for u in rj(os.path.join(OUT4, "h2-units.json"))["units"]}
    runs = {}
    for tag in ("B", "Br", "A"):
        name = {"B": "base-%s", "Br": "base-%s-rep", "A": arm + "-%s"}[tag]
        r1, r2 = run(name % "heldout"), run(name % "heldout2")
        merged = {("h1:" + k.split(":", 1)[1]): v for k, v in r1.items()}
        merged.update({"h2:" + k: v for k, v in r2.items()})
        runs[tag] = merged
    B, Br, A = runs["B"], runs["Br"], runs["A"]
    h1_ids = sorted("h1:" + i for i in labels)
    h2_ids = sorted("h2:" + i for i in h2)
    clusters = {i: "note:" + recs[i[3:]]["source_key"] for i in h1_ids}
    clusters.update({i: "section:" + h2[i[3:]]["section"] for i in h2_ids})
    pooled = h1_ids + h2_ids

    def ref_breaking(i):
        return bool(labels[i[3:]]["breaking"]) if i.startswith("h1:") else bool(h2[i[3:]]["breaking"])

    def ref_oblig(i):
        return labels[i[3:]]["change_type"] in OBLIG if i.startswith("h1:") else bool(h2[i[3:]]["obligation"])

    def ref_ct_ok(i, ct):
        return ct == labels[i[3:]]["change_type"] if i.startswith("h1:") else ct in h2[i[3:]]["change_types"]

    def ben_ref(i):
        return [b for b in labels[i[3:]]["benefit"] if b != "none"]

    def binpairs(R, s, pred, ref):
        out = []
        for i in s:
            c, t = R.get(i), ref(i)
            out.append(((not t) if c is None else pred(c), t))
        return out

    P = {
        "breaking": (lambda c: yes(c, "breaking"), ref_breaking),
        "oblig": (lambda c: c["answers"]["change_type"]["choice"] in OBLIG, ref_oblig),
        "benefit": (lambda c: any(yes(c, "benefit_" + b) for b in BENEFITS), lambda i: bool(ben_ref(i))),
        "actionable": (lambda c: c["answers"]["surface"]["choice"] != "runtime_internal", lambda i: bool(labels[i[3:]]["actionable"])),
    }

    def R_(k):
        return lambda R, s: rec(binpairs(R, s, *P[k]))

    def P_(k):
        return lambda R, s: prec(binpairs(R, s, *P[k]))

    def npos(k):
        return lambda R, s: sum(P[k][1](i) for i in s)

    def npred(k):
        return lambda R, s: sum(p for p, _ in binpairs(R, s, *P[k]))

    ct = lambda R, s: acc([bool(R.get(i)) and ref_ct_ok(i, R[i]["answers"]["change_type"]["choice"]) for i in s])
    spec = [
        ("breaking recall (H1+H2)", pooled, R_("breaking"), npos("breaking")),
        ("breaking precision (H1+H2)", pooled, P_("breaking"), npred("breaking")),
        ("removal/deprecation recall (H1+H2)", pooled, R_("oblig"), npos("oblig")),
        ("removal/deprecation precision (H1+H2)", pooled, P_("oblig"), npred("oblig")),
        ("change_type agreement (H1+H2)", pooled, ct, lambda R, s: len(s)),
        ("benefit-vs-none recall (H1)", h1_ids, R_("benefit"), npos("benefit")),
        ("benefit-vs-none precision (H1)", h1_ids, P_("benefit"), npred("benefit")),
        ("actionable recall (H1)", h1_ids, R_("actionable"), npos("actionable")),
        ("actionable precision (H1)", h1_ids, P_("actionable"), npred("actionable")),
    ]
    rows = [judge(n, ids, clusters, v, d, B, Br, A, 100 + k) for k, (n, ids, v, d) in enumerate(spec)]
    # Descriptive: per set, per benefit, arm vs Br, flips.
    desc = {}
    for setname, ids in (("H1", h1_ids), ("H2", h2_ids)):
        for k in ("breaking", "oblig"):
            desc["%s %s recall" % (setname, k)] = [R_(k)(X, ids) for X in (B, Br, A)]
            desc["%s %s precision" % (setname, k)] = [P_(k)(X, ids) for X in (B, Br, A)]
        desc["%s change_type agreement" % setname] = [ct(X, ids) for X in (B, Br, A)]
    for b in BENEFITS:
        pr = (lambda c, b=b: yes(c, "benefit_" + b), lambda i, b=b: b in ben_ref(i))
        desc["H1 benefit:%s recall" % b] = [rec(binpairs(X, h1_ids, *pr)) for X in (B, Br, A)]
        desc["H1 benefit:%s precision" % b] = [prec(binpairs(X, h1_ids, *pr)) for X in (B, Br, A)]
    vs_rep = [judge(n, ids, clusters, v, d, Br, B, A, 200 + k) for k, (n, ids, v, d) in enumerate(spec)]
    fl = {f: {"arm": flips(A, B, pooled, f), "rep": flips(Br, B, pooled, f)} for f in FIELDS}
    unans = {t: sum(X.get(i) is None for i in pooled) for t, X in runs.items()}
    tok = {}
    for t, name in (("B", "base"), ("Br", "base"), ("A", arm)):
        sfx = "-rep" if t == "Br" else ""
        ms = [meta("%s-%s%s" % (name, s, sfx)) for s in ("heldout", "heldout2")]
        tok[t] = sum(m["input_tokens"] for m in ms) / sum(m["units"] for m in ms)
        tok[t + "_dollars"] = sum(m["dollars"] for m in ms)
    saving = tok["B"] - tok["A"]
    yr = saving * 0.042e-6 * 114.6 * 20000
    passed = all(r["pass"] for r in rows)
    report = {"arm": arm, "pass": passed, "rows": rows, "vs_Br": vs_rep, "descriptive": desc, "flips": fl, "unanswered": unans,
              "tokens_per_record": tok, "saving_tokens_per_record": saving, "saving_share": saving / tok["B"], "saving_usd_per_year_20k": yr}
    with open(os.path.join(OUT9, "heldout-report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("== %s held-out (H1 233 + H2 347): %s" % (arm, "PASS" if passed else "FAIL"))
    show(rows)
    print("tokens/record B %.0f Br %.0f arm %.0f: saving %.0f (%.1f%%), $%.1f/yr at 20k technologies" % (tok["B"], tok["Br"], tok["A"], saving, 100 * saving / tok["B"], yr))
    print("unanswered", unans)
    print("flip rate vs B (arm / rep): " + "  ".join("%s %.1f/%.1f" % (f, 100 * v["arm"], 100 * v["rep"]) for f, v in fl.items()))
    for k, v in desc.items():
        print("  %-36s B %5.1f Br %5.1f arm %5.1f" % (k, *(100 * x for x in v)))


if __name__ == "__main__":
    if sys.argv[1] == "dev":
        dev(sys.argv[2:])
    else:
        heldout(sys.argv[2])
