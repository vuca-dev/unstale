"""Port parity: every cell scored and costed into results/ (PREREGISTRATION.md). No model call.

    python3 analyze.py

Reads out/cells/*.out.jsonl, *.usage.jsonl and *.summary.json (run_cell.sh), the replayed cells under out/free/, and
central's stored runs under eval/select/out. Writes results/<cell>.json, results/summary.json and results/table.md.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, "..", "select", "out")
CELLS = os.path.join(HERE, "out", "cells")
RES = os.path.join(HERE, "results")
os.makedirs(RES, exist_ok=True)
rj = lambda p: json.load(open(p))
# $ per million tokens: the gateway's list price for gpt-6-luna (eval/select/prices.json); flex is half. The
# labelling service bills input only.
LUNA = {"input": 0.10, "cached": 0.01, "output": 0.50}
SERVICE_IN = 0.042
# Central's mean technology-year (slice3/cost3.py, cost.mts): note tokens, chunks, records, and its prompt constants.
N, CHUNKS, R = 6460, 17.5, 114.6
P_A, P_B, O_A = 597, 874, 85


def score(args, dest):
    r = subprocess.run([sys.executable, os.path.join(HERE, "score.py")] + args + ["--json", dest], capture_output=True, text=True)
    if r.returncode:
        print("score.py %s failed: %s" % (" ".join(args[:3]), (r.stderr or r.stdout)[-400:]))
        return None
    return rj(dest)


def usage(cell):
    p = os.path.join(CELLS, cell + ".summary.json")
    if not os.path.exists(p):
        return None
    s = rj(p)
    fresh = s["input"] - s["cached"]
    s["dollars_list"] = (fresh * LUNA["input"] + s["cached"] * LUNA["cached"] + s["output"] * LUNA["output"]) / 1e6
    b, a = s.get("gateway_balance_before"), s.get("gateway_balance_after")
    # Cells ran side by side, so one cell's balance change includes its neighbours'; the total is read over all cells.
    s["gateway_balance_change"] = None if b is None or a is None else round(b - a, 6)
    return s


def ci(d):
    return "%+.1f [%+.1f, %+.1f]" % (100 * d["diff"], 100 * d["ci"][0], 100 * d["ci"][1])


rows, out = [], {}


def row(cell, step, route, metric, central, client, band, ok, note=""):
    rows.append({"cell": cell, "step": step, "route": route, "metric": metric, "central": central, "client": client, "band": band, "verdict": "pass" if ok else "FAIL", "note": note})


inside = lambda d: d["ci"][0] <= 0 <= d["ci"][1]
p1 = lambda x: "%.1f" % (100 * x)

# ---- Cells 1, 2, 9: extraction ----
CEN1 = [os.path.join(C, "slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout"), os.path.join(C, "slice3c", "runs", "vercel_openai_gpt-6-luna-two-call-heldout-rep2"),
        os.path.join(C, "provider-matrix", "runs", "openai_gpt-6-luna-two-call-heldout")]
CEN2 = [os.path.join(C, "slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout2"), os.path.join(C, "slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout2-rep2")]


def extraction(cell, sset, cen, n, route, metrics):
    f = os.path.join(CELLS, cell + ".out.jsonl")
    if not os.path.exists(f) or not os.path.exists(os.path.join(CELLS, cell + ".summary.json")):
        return None
    args = ["extract", sset, f, "--central", cen[0]]
    for c in cen[1:]:
        args += ["--also", c]
    r = score(args, os.path.join(RES, cell + ".json"))
    if not r:
        return None
    r["usage"] = usage(cell)
    first = os.path.basename(cen[0])
    for key, cname, label in metrics:
        d = r["client_minus_central"][first][cname]
        others = "; ".join("%s %s" % (k.split(" minus ")[0].replace("vercel_openai_gpt-6-luna-two-call-", "gateway ").replace("openai_gpt-6-luna-two-call-", "direct "), ci(v[cname])) for k, v in r["central_runs_against_each_other"].items() if k.endswith("minus " + first))
        row(n, "extraction", route, label, p1(r["central"][first][key]), p1(r["client"][key]), "client − central " + ci(d), inside(d), "central's own runs against its first: " + others)
    json.dump(r, open(os.path.join(RES, cell + ".json"), "w"), indent=1, default=list)
    return r


M1 = [("pooled_excl_unsure", "pooled_excl_unsure", "recall, pooled"), ("macro_excl_unsure", "macro_excl_unsure", "recall, mean per technology"), ("breaking", "breaking", "recall, breaking"), ("precision", "precision", "precision")]
M2 = [("required_sure", "recall, required excl. unsure", "recall, required"), ("breaking", "recall, breaking groups", "recall, breaking"), ("precision", "precision", "precision")]
out["extract-short-gateway"] = extraction("extract-short-gateway", "h1", CEN1, 1, "gpt-6-luna, gateway", M1)
out["extract-guides-gateway"] = extraction("extract-guides-gateway", "h2", CEN2, 2, "gpt-6-luna, gateway", M2)
# Cell 9: Codex against the client's own direct-route run (cell 1), then central's.
direct = os.path.join(HERE, "out", "scored", "extract-short-gateway")
if os.path.exists(os.path.join(direct, "incoming.json")):
    out["extract-short-codex"] = extraction("extract-short-codex", "h1", [direct] + CEN1, 9, "Codex, batched 8", M1)

# ---- Cells 3, 4, 7: replayed labelling-service answers ----
for n, cell, sset, run in ((3, "jev-labels-h1", "h1", "jev-heldout-qv1"), (4, "jev-labels-h2", "h2", "jev-heldout2-qv1")):
    r = score(["labels", sset, os.path.join(HERE, "out", "free", cell + ".out.jsonl"), "--central", os.path.join(C, "slice4", "runs", run, "answers.json"), "--exact"], os.path.join(RES, "replay-" + cell + ".json"))
    if r:
        out["replay-" + cell] = r
        keys = ("breaking_recall", "benefit_recall", "actionable_recall", "change_type_acc") if sset == "h1" else ("breaking_recall", "breaking_precision")
        row(n, "labels", "labelling service (stored answers replayed)", " / ".join(k.replace("_", " ") for k in keys), " / ".join(p1(r["central"][k]) for k in keys), " / ".join(p1(r["client"][k]) for k in keys),
            "exact: %d of %d records labelled as central" % (r["n"] - len(r["records_with_a_different_label"]), r["n"]), r["exact"])
r = score(["match", os.path.join(HERE, "out", "free", "jev-match.out.jsonl"), "--central", os.path.join(HERE, "out", "central", "match-jev-q8.json"), "--exact"], os.path.join(RES, "replay-jev-match.json"))
if r:
    out["replay-jev-match"] = r
    c, k = r["central"]["match-jev-q8"], r["client"]
    row(7, "matching", "labelling service (stored answers replayed)", "merge recall; false merges per 100", "%d/%d = %s; %.1f" % (c["recalled"], c["same_items"], p1(c["recall"]), c["false_per_100"]),
        "%d/%d = %s; %.1f" % (k["recalled"], k["same_items"], p1(k["recall"]), k["false_per_100"]), "exact: %d of %d items decided as central" % (r["n"] - len(r["items_differing_from_production_pick"]), r["n"]), r["exact"])

# ---- Cells 5, 6: labels by choice ----
for n, cell, sset, run in ((5, "labels-set1-choice", "h1", "choice_openai_gpt-6-luna-heldout"), (6, "labels-set2-choice", "h2", "choice_openai_gpt-6-luna-heldout2")):
    f = os.path.join(CELLS, cell + ".out.jsonl")
    if not os.path.exists(os.path.join(CELLS, cell + ".summary.json")):
        continue
    r = score(["labels", sset, f, "--central", os.path.join(C, "slice4", "runs", run, "answers.json")], os.path.join(RES, cell + ".json"))
    if not r:
        continue
    r["usage"] = usage(cell)
    json.dump(r, open(os.path.join(RES, cell + ".json"), "w"), indent=1)
    out[cell] = r
    names = (("breaking_recall", "breaking recall"), ("benefit_recall", "benefit-vs-none recall"), ("actionable_recall", "actionable recall (yes)"), ("change_type_acc", "change_type accuracy")) if sset == "h1" else (("breaking_recall", "breaking recall"), ("breaking_precision", "breaking precision"))
    for key, cname in names:
        d = r["client_minus_central"][cname]
        row(n, "labels", "gpt-6-luna by choice, gateway", cname, p1(r["central"][key]), p1(r["client"][key]), "client − central " + ci(d), inside(d), "%d of %d answered" % (r["client_answered"], r["n"]))

# ---- Cell 8: matching by choice ----
if os.path.exists(os.path.join(CELLS, "match-choice.summary.json")):
    r = score(["match", os.path.join(CELLS, "match-choice.out.jsonl"), "--central", os.path.join(HERE, "out", "central", "match-luna-choice.json"), "--also", os.path.join(HERE, "out", "central", "match-jev-q8.json"),
               "--also", os.path.join(HERE, "out", "central", "match-jev-j1.json")], os.path.join(RES, "match-choice.json"))
    if r:
        r["usage"] = usage("match-choice")
        json.dump(r, open(os.path.join(RES, "match-choice.json"), "w"), indent=1)
        out["match-choice"] = r
        c, k, d = r["central"]["match-luna-choice"], r["client"], r["client_minus_central"]["match-luna-choice"]
        row(8, "matching", "gpt-6-luna by choice, production rule", "merge recall", "%d/%d = %s" % (c["recalled"], c["same_items"], p1(c["recall"])), "%d/%d = %s" % (k["recalled"], k["same_items"], p1(k["recall"])),
            "client − central %+.1f [%+.1f, %+.1f], McNemar p %.3g" % (100 * d["recall_diff"], 100 * d["recall_diff_ci95"][0], 100 * d["recall_diff_ci95"][1], d["recall_mcnemar_p"]), d["recall_diff_ci95"][0] <= 0 <= d["recall_diff_ci95"][1],
            "%d requests unreadable after three attempts" % r["client_failed"])
        row(8, "matching", "gpt-6-luna by choice, production rule", "false merges per 100 merges", "%.1f" % c["false_per_100"], "%.1f" % k["false_per_100"], "McNemar p %.3g (%d central only, %d client only)" % (d["false_mcnemar_p"], d["false_central_only"], d["false_client_only"]), d["false_mcnemar_p"] >= 0.05)

# ---- Live samples of the labelling service ----
samples = {}
for cell in ("labels-set1-service-sample", "labels-set2-service-sample", "match-service-sample"):
    u = usage(cell)
    if u:
        models = sorted({json.loads(l)["model"] for l in open(os.path.join(CELLS, cell + ".usage.jsonl"))})
        samples[cell] = {"items": u["items_in"], "answered": u["lines_out"], "served_by": models, "input_tokens": u["input"], "input_per_item": u["input"] / u["items_in"], "dollars": u["input"] * SERVICE_IN / 1e6}
out["labelling_service_live_samples"] = samples

# ---- Cost per mean technology-year ----
cost = {}
for cell, name in (("extract-short-gateway", "short notes"), ("extract-guides-gateway", "guides")):
    r = out.get(cell)
    if r and r.get("usage"):
        u = r["usage"]
        log = [json.loads(l) for l in open(os.path.join(CELLS, cell + ".out.jsonl"))]
        inputs = [json.loads(l) for l in open(os.path.join(HERE, "out", "inputs", "extract-%s.jsonl" % ("h1" if "short" in cell else "h2")))]
        chunks = sum(1 for e in inputs for c in e["chunks"] if not c.get("content_free"))
        with_records = len({i["key"].rsplit(".", 1)[0] for e in log for i in e["incoming"]})
        needed = chunks + with_records
        factor = u["calls"] / needed
        out_per_rec = u["output"] / max(1, r["client"]["records"])
        tin = factor * (2 * N + R * O_A * 1.5 + CHUNKS * (P_A + P_B))
        tout = factor * R * out_per_rec
        usd = (tin * LUNA["input"] + tout * LUNA["output"]) / 1e6
        cost["extraction, gpt-6-luna (from %s)" % name] = {"input_tokens": round(tin), "output_tokens": round(tout), "dollars_list": usd, "dollars_flex": usd / 2, "calls_per_needed_call": factor, "output_per_record": out_per_rec,
                                                              "measured_on_set": {"calls": u["calls"], "input": u["input"], "cached": u["cached"], "output": u["output"], "reasoning": u["reasoning"], "records": r["client"]["records"]}}
for cell, name in (("labels-set1-choice", "label set 1"), ("labels-set2-choice", "label set 2")):
    r = out.get(cell)
    if r and r.get("usage"):
        u = r["usage"]
        tin, tout = u["input"] / r["n"] * R, u["output"] / r["n"] * R
        usd = ((u["input"] - u["cached"]) * LUNA["input"] + u["cached"] * LUNA["cached"] + u["output"] * LUNA["output"]) / 1e6 / r["n"] * R
        cost["labels, gpt-6-luna by choice (from %s)" % name] = {"input_tokens": round(tin), "output_tokens": round(tout), "dollars_list": usd, "dollars_flex": usd / 2, "per_record": {"input": u["input"] / r["n"], "output": u["output"] / r["n"], "reasoning": u["reasoning"] / r["n"], "calls": u["calls"] / r["n"]}}
r = out.get("match-choice")
if r and r.get("usage"):
    u = r["usage"]
    tin, tout = u["input"] / r["n"] * R, u["output"] / r["n"] * R
    usd = ((u["input"] - u["cached"]) * LUNA["input"] + u["cached"] * LUNA["cached"] + u["output"] * LUNA["output"]) / 1e6 / r["n"] * R
    cost["matching, gpt-6-luna by choice"] = {"input_tokens": round(tin), "output_tokens": round(tout), "dollars_list": usd, "dollars_flex": usd / 2, "per_request": {"input": u["input"] / r["n"], "output": u["output"] / r["n"], "reasoning": u["reasoning"] / r["n"], "calls": u["calls"] / r["n"]}}
for cell, name in (("labels-set1-service-sample", "labels, labelling service"), ("match-service-sample", "matching, labelling service")):
    s = samples.get(cell)
    if s:
        cost[name + " (live sample of 25)"] = {"input_tokens": round(s["input_per_item"] * R), "output_tokens": 0, "dollars_list": s["input_per_item"] * R * SERVICE_IN / 1e6, "per_item_input": s["input_per_item"]}
r = out.get("extract-short-codex")
if r and r.get("usage"):
    u = r["usage"]
    inputs = [json.loads(l) for l in open(os.path.join(HERE, "out", "inputs", "extract-h1.jsonl"))]
    chunks = sum(1 for e in inputs for c in e["chunks"] if not c.get("content_free"))
    total = u["input"] + u["output"]
    cost["extraction, Codex batched 8 (plan tokens, harness included; from short notes)"] = {
        "plan_tokens_per_chunk": total / chunks, "plan_tokens": round(total / chunks * CHUNKS), "of_which_cached_input": round(u["cached"] / chunks * CHUNKS), "output_tokens": round(u["output"] / chunks * CHUNKS),
        "dollars_list_equivalent": ((u["input"] - u["cached"]) * LUNA["input"] + u["cached"] * LUNA["cached"] + u["output"] * LUNA["output"]) / 1e6 / chunks * CHUNKS,
        "measured_on_set": {"calls": u["calls"], "input": u["input"], "cached": u["cached"], "output": u["output"], "reasoning": u["reasoning"], "chunks": chunks}}
out["cost_per_technology_year"] = cost

# ---- Spend ----
spend = {}
for cell in sorted(f[:-len(".summary.json")] for f in os.listdir(CELLS) if f.endswith(".summary.json")) if os.path.exists(CELLS) else []:
    u = usage(cell)
    service = "service" in cell
    codex = "codex" in cell
    spend[cell] = {"calls": u["calls"], "input": u["input"], "cached": u["cached"], "output": u["output"], "reasoning": u["reasoning"], "wall_s": u["wall_s"],
                   "dollars_list": 0.0 if codex else u["input"] * SERVICE_IN / 1e6 if service else u["dollars_list"], "billed_to": "Codex plan" if codex else "labelling service" if service else "gateway",
                   "gateway_balance_before": u.get("gateway_balance_before"), "gateway_balance_after": u.get("gateway_balance_after")}
bal = [(s["gateway_balance_before"], s["gateway_balance_after"]) for s in spend.values() if s["gateway_balance_before"] is not None]
out["spend"] = {"cells": spend, "dollars_list_total": sum(s["dollars_list"] for s in spend.values()),
                "gateway_billed_total": round(max(b for b, _ in bal) - min(a for _, a in bal), 6) if bal else None,
                "plan_tokens_codex": sum(s["input"] + s["output"] for s in spend.values() if s["billed_to"] == "Codex plan")}
out["table"] = rows
json.dump(out, open(os.path.join(RES, "summary.json"), "w"), indent=1, default=list)
with open(os.path.join(RES, "table.md"), "w") as fh:
    fh.write("| Cell | Step | Route | Metric | Central | Client | Band | Verdict |\n|---|---|---|---|---|---|---|---|\n")
    for r in rows:
        fh.write("| %s | %s | %s | %s | %s | %s | %s | %s |\n" % (r["cell"], r["step"], r["route"], r["metric"], r["central"], r["client"], r["band"], r["verdict"]))
for r in rows:
    print("%s | %-10s | %-44s | %-34s | %-28s | %-28s | %-52s | %s" % (r["cell"], r["step"], r["route"], r["metric"], r["central"], r["client"], r["band"], r["verdict"]))
print(json.dumps(out["spend"], indent=1)[:1500])
print(json.dumps(cost, indent=1)[:3500])
