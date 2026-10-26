"""Slice 14, step D (PREREG.md): SubQ Snap 1.1 against Jev on the pipeline's wording (v1). No model calls.

    python3 eval/select/slice14/analyze_d.py [--arm subq-1.1] [--d1] [--suffix -qx1 --act x2|x3] [--json OUT]

Fits on dev with slice 4's `analyze.fit`; H1 with slice 4's metrics and paired `compare`; H2 with `analyze_h2`'s
section-cluster bootstrap; repeatability and cost per technology-year. Runs are under out/slice4/runs.
"""
import argparse, importlib.util, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
S4 = os.path.join(HERE, "..", "slice4")
sys.path.insert(0, S4)
import analyze as A  # noqa: E402  (slice 4)
import analyze_h2 as H  # noqa: E402

OUT = os.path.join(HERE, "..", "out", "slice14")
PRICE = {"jev": 0.042, "subq-1.1": 0.04}
JEV = {"dev": "jev-dev-qv1", "h1": "jev-heldout-qv1", "h1r2": "jev-heldout-qv1-r2", "h2": "jev-heldout2-qv1"}


def jev_runs(sfx):
    """Round 2: Jev under the arm's request (fresh runs); no suffix = the stored v1 runs."""
    return dict(JEV) if not sfx else {"dev": "jev-dev" + sfx, "h1": "jev-heldout" + sfx, "h1r2": "jev-heldout" + sfx + "-r2", "h2": "jev-heldout2" + sfx}


def runs(arm, sfx=""):
    """run4.mts run ids: <cand>-<split>[-q<qv>][-<tag>]."""
    return {"dev": arm + "-dev" + sfx, "h1": arm + "-heldout" + sfx, "h1r2": arm + "-heldout" + sfx + "-r2", "h2": arm + "-heldout2" + sfx}


def ans(run):
    p = os.path.join(A.RUNS, run, "answers.json")
    return A.rj(p) if os.path.exists(p) else None


def save(pred, name):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + ".json")
    json.dump(pred, open(p, "w"), indent=1)
    return p


def h2_pred(a, bt):
    return {uid: ({"breaking": x["answers"]["breaking"]["probabilities"]["yes"] >= bt, "change_type": x["answers"]["change_type"]["choice"]} if x else None) for uid, x in a.items()}


def to_pred(a, bt, nt, tau=None, act=None):
    """slice 4's mapping; with tau (PREREG round 1, D1), actionable unless p(runtime_internal) >= tau. act (round 2):
    "x2" = the direct actionable question at p(yes) >= 0.5; "x3" = surface argmax != runtime_internal or breaking."""
    out = A.to_pred(a, bt, nt)
    for uid, c in a.items():
        if not c:
            continue
        o, q = out[uid.split(":", 1)[1]], c["answers"]
        if tau is not None:
            o["actionable"] = q["surface"]["probabilities"]["runtime_internal"] < tau
        if act == "x2":
            o["actionable"] = q["actionable"]["probabilities"]["yes"] >= 0.5
        elif act == "x3":
            o["actionable"] = o["actionable"] or o["breaking"]
    return out


def actionable_share(a, tau=None):
    xs = [c["answers"]["surface"] for c in a.values() if c]
    return sum((x["probabilities"]["runtime_internal"] < tau) if tau is not None else (x["choice"] != "runtime_internal") for x in xs) / len(xs)


def fit_d1(jev_dev, snap_dev, f):
    """PREREG round 1 (D1): BREAKING_P by dev F2 subject to dev precision >= Jev's at 0.5; tau matched to Jev's dev actionable share."""
    ref = A.rj(os.path.join(A.OUT, "encoder", "dev-ref.json"))["breaking"]

    def pr(a, t):
        tp = fp = fn = 0
        for rid, truth in ref.items():
            c = a.get("breaking:" + rid)
            pred = (A.p_yes(c, "breaking") >= t) if c else (not truth)
            tp += truth and pred
            fp += (not truth) and pred
            fn += truth and not pred
        return tp / max(1, tp + fp), A.fbeta(tp, fp, fn)
    floor_p = pr(jev_dev, 0.5)[0]
    ok = [t for t in A.GRID if pr(snap_dev, t)[0] >= floor_p]
    best = max(pr(snap_dev, t)[1] for t in ok)
    bt = min((t for t in ok if abs(pr(snap_dev, t)[1] - best) < 1e-12), key=lambda t: abs(t - 0.5))
    target = actionable_share(jev_dev)
    tau = min(t for t in [round(0.5 + 0.05 * i, 2) for i in range(10)] if actionable_share(snap_dev, t) >= target)
    return dict(f, BREAKING_P=bt, tau=tau, jev_dev_precision_05=floor_p, snap_dev_precision=pr(snap_dev, bt)[0], jev_dev_actionable=target, snap_dev_actionable=actionable_share(snap_dev, tau))


def flips(a, b, bt, nt, tau=None):
    pa, pb = to_pred(a, bt, nt, tau), to_pred(b, bt, nt, tau)
    return sum(1 for k in set(pa) | set(pb) if pa.get(k) != pb.get(k))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", default="subq-1.1")
    ap.add_argument("--suffix", default="", help="run-id suffix after the split, e.g. -qv2")
    ap.add_argument("--price", type=float, default=PRICE["subq-1.1"], help="$ per M input for the arm")
    ap.add_argument("--d1", action="store_true", help="PREREG round 1 (D1) fit and mapping")
    ap.add_argument("--act", choices=("x2", "x3"), help="round 2 actionable mapping, for both candidates")
    ap.add_argument("--jev-suffix", default=None, help="round 2: Jev runs under the same request (default: --suffix if given)")
    ap.add_argument("--json")
    o = ap.parse_args()
    S = runs(o.arm, o.suffix)
    JR = jev_runs(o.suffix if o.jev_suffix is None else o.jev_suffix)
    act = o.act
    labels_path = os.path.join(A.OUT, "adjudicated-records.json")
    labels = A.rj(labels_path)
    rep = {"arm": o.arm}
    fj, fs = A.fit(JR["dev"]), A.fit(S["dev"])
    if o.d1:
        fs = fit_d1(ans(JR["dev"]), ans(S["dev"]), fs)
        print("D1 fit", json.dumps(fs))
    tau = fs.get("tau")
    rep["fit"] = {"jev": fj, "snap": fs}
    print("fit Jev v1 %.2f/%.2f  Snap %.2f/%.2f (BREAKING_P/BENEFIT_P)" % (fj["BREAKING_P"], fj["BENEFIT_P"], fs["BREAKING_P"], fs["BENEFIT_P"]))

    # H1: Jev at its fitted thresholds (slice 4 rule) and at 0.5 (production); Snap at its fitted thresholds.
    jh, sh = ans(JR["h1"]), ans(S["h1"])
    tg = o.suffix + ("-" + act if act else "")
    pj = save(to_pred(jh, fj["BREAKING_P"], fj["BENEFIT_P"], act=act), "h1-jev%s-fit" % tg)
    pj5 = save(to_pred(jh, 0.5, 0.5, act=act), "h1-jev%s-05" % tg)
    ps = save(to_pred(sh, fs["BREAKING_P"], fs["BENEFIT_P"], tau, act), "h1-%s%s%s-fit" % (o.arm, tg, "-d1" if o.d1 else ""))
    ps5 = save(to_pred(sh, 0.5, 0.5, act=act), "h1-%s%s-05" % (o.arm, tg))
    rep["h1"] = {k: A.metrics(A.rj(p), labels) for k, p in (("jev_fit", pj), ("jev_05", pj5), ("snap_fit", ps), ("snap_05", ps5))}
    res, txt = A.compare(pj, ps, labels_path)
    res05, _ = A.compare(pj5, ps, labels_path)
    rep["h1_vs_jev_fit"], rep["h1_vs_jev_05"] = res, res05
    print(txt)
    why = []
    for cname, key in (("breaking recall", "breaking_recall"), ("benefit-vs-none recall", "benefit_recall"), ("actionable recall (yes)", "actionable_recall")):
        if rep["h1"]["snap_fit"][key] < rep["h1"]["jev_fit"][key] - 0.05:
            why.append("H1 %s > 5 pts below" % key)
        if res[cname]["ci"][1] < 0:
            why.append("H1 %s significantly worse" % key)
    # Round 2 guards (PREREG addendum): change_type accuracy as the recalls; actionable precision <= 5 pts below.
    if rep["h1"]["snap_fit"]["change_type_acc"] < rep["h1"]["jev_fit"]["change_type_acc"] - 0.05:
        why.append("H1 change_type_acc > 5 pts below")
    if res["change_type accuracy"]["ci"][1] < 0:
        why.append("H1 change_type_acc significantly worse")
    if rep["h1"]["snap_fit"]["actionable_precision"] < rep["h1"]["jev_fit"]["actionable_precision"] - 0.05:
        why.append("H1 actionable_precision > 5 pts below")

    # H2: breaking at Snap's fitted threshold against Jev at 0.5 (H2's rule), section-cluster bootstrap.
    units = {u["id"]: u for u in A.rj(os.path.join(H.OUT4, "h2-units.json"))["units"]}
    ids = sorted(units)
    jh2, sh2 = ans(JR["h2"]), ans(S["h2"])
    rep["h2"] = {}
    if jh2 and sh2:
        clusters = {i: units[i]["section"] for i in ids}
        pos = [i for i in ids if units[i]["breaking"]]
        obl = [i for i in ids if units[i]["obligation"]]
        j = h2_pred(jh2, 0.5)
        for tag, bt in (("fit", fs["BREAKING_P"]), ("05", 0.5)):
            b = h2_pred(sh2, bt)
            side = lambda s, b=b: j if s == "a" else b
            hit = lambda p: {i: bool(p.get(i) and p[i]["breaking"]) == units[i]["breaking"] for i in ids}
            ca, cb = hit(j), hit(b)
            rng = random.Random(20261016)
            r = {"recall": H.recall(ids, b, units), "precision": H.precision(ids, b, units), "jev_recall": H.recall(ids, j, units), "jev_precision": H.precision(ids, j, units),
                 "obligation": H.oblig(ids, b, units), "jev_obligation": H.oblig(ids, j, units)}
            print("== H2 Snap @%.2f vs Jev @0.5" % bt)
            r["breaking_recall"] = H.sc.paired("breaking recall", pos, ca, cb, lambda s, x: H.recall(s, side(x), units), rng, clusters)
            r["breaking_precision"] = H.sc.paired("breaking precision", ids, ca, cb, lambda s, x: H.precision(s, side(x), units), rng, clusters)
            co = lambda p: {i: bool(p.get(i) and p[i]["change_type"] in H.OBLIG) for i in ids}
            r["obligation_recall"] = H.sc.paired("obligation recall (descr.)", obl, co(j), co(b), lambda s, x: H.oblig(s, side(x), units), rng, clusters)
            rep["h2"][tag] = {k: (dict(v, ci=list(v["ci"])) if isinstance(v, dict) else v) for k, v in r.items()}
        for k in ("breaking_recall", "breaking_precision"):
            if rep["h2"]["fit"][k]["ci"][1] < 0:
                why.append("H2 %s significantly worse at the fitted threshold" % k)
    else:
        why.append("H2 run missing")
    rep["floor_pass"], rep["floor_why"] = not why, why

    # Repeatability (H1 second run) and cost.
    rep["repeat"] = {}
    for name, R, f in (("jev", JR, fj), ("snap", S, fs)):
        b = ans(R["h1r2"])
        a1 = ans(R["h1"])
        if b:
            same = sum(1 for k in a1 if a1[k] and b.get(k) and a1[k]["answers"] == b[k]["answers"])
            rep["repeat"][name] = {"flips_fit": flips(a1, b, f["BREAKING_P"], f["BENEFIT_P"], f.get("tau")), "flips_05": flips(a1, b, 0.5, 0.5), "identical_answers": same, "n": len(a1)}
    rep["cost"] = {}
    for name, R in (("jev", JR), ("snap", S)):
        m = A.rj(os.path.join(A.RUNS, R["h1"], "meta.json"))
        price = PRICE["jev"] if name == "jev" else o.price
        per = m["input_per_record"] * price / 1e6  # input tokens per record as billed, retries included; output free
        rep["cost"][name] = {"input_per_record": m["input_per_record"], "per_record": per, "tech_year_mean": per * A.R_MEAN, "tech_year_max": per * A.R_MAX, "fleet_10k": per * A.R_MEAN * 1e4}
    rep["cost"]["ratio"] = rep["cost"]["snap"]["tech_year_mean"] / rep["cost"]["jev"]["tech_year_mean"]
    pc = lambda v: "%.1f" % (100 * v)
    for k, m in rep["h1"].items():
        print("H1 %-9s bR %s bnR %s aR %s aP %s | bP %s bnP %s ct %s obl %s" % (k, pc(m["breaking_recall"]), pc(m["benefit_recall"]), pc(m["actionable_recall"]), pc(m["actionable_precision"]), pc(m["breaking_precision"]), pc(m["benefit_precision"]), pc(m["change_type_acc"]), pc(m["obligation_recall"])))
    for tag, r in rep["h2"].items():
        print("H2 %s: Snap R %s P %s obl %s | Jev R %s P %s obl %s | CI R %s P %s obl %s" % (tag, pc(r["recall"]), pc(r["precision"]), pc(r["obligation"]), pc(r["jev_recall"]), pc(r["jev_precision"]), pc(r["jev_obligation"]), r["breaking_recall"]["ci"], r["breaking_precision"]["ci"], r["obligation_recall"]["ci"]))
    print("repeat", json.dumps(rep["repeat"]))
    print("cost", json.dumps(rep["cost"]))
    print("FLOOR", "PASS" if rep["floor_pass"] else "FAIL", why)
    if o.json:
        json.dump(rep, open(o.json, "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
