"""Jev repeatability: flip rate per field between the two fresh held-out runs (J1, J2), and mean |dp|. No labels used."""
import json, os, sys
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "slice4", "runs")
a = json.load(open(os.path.join(R, sys.argv[1] if len(sys.argv) > 1 else "jev-heldout-run1", "answers.json")))
b = json.load(open(os.path.join(R, sys.argv[2] if len(sys.argv) > 2 else "jev-heldout-run2", "answers.json")))
ids = [i for i in a if a[i] and b.get(i)]
B = ["security", "correctness", "performance", "cost", "maintainability"]
def yes(c, q): return c["answers"][q]["probabilities"]["yes"]
out = {"n": len(ids)}
for q in ["breaking"] + ["benefit_" + x for x in B]:
    out[q] = {"flips@0.5": sum((yes(a[i], q) >= .5) != (yes(b[i], q) >= .5) for i in ids), "mean_abs_dp": sum(abs(yes(a[i], q) - yes(b[i], q)) for i in ids) / len(ids),
              "identical_p": sum(yes(a[i], q) == yes(b[i], q) for i in ids)}
out["benefit_any"] = {"flips@0.5": sum(any(yes(a[i], "benefit_" + x) >= .5 for x in B) != any(yes(b[i], "benefit_" + x) >= .5 for x in B) for i in ids)}
for q in ["change_type", "surface"]:
    out[q] = {"flips": sum(a[i]["answers"][q]["choice"] != b[i]["answers"][q]["choice"] for i in ids)}
out["actionable"] = {"flips": sum((a[i]["answers"]["surface"]["choice"] == "runtime_internal") != (b[i]["answers"]["surface"]["choice"] == "runtime_internal") for i in ids)}
out["any_field"] = sum(any([(yes(a[i], q) >= .5) != (yes(b[i], q) >= .5) for q in ["breaking"] + ["benefit_" + x for x in B]] + [a[i]["answers"][q]["choice"] != b[i]["answers"][q]["choice"] for q in ["change_type", "surface"]]) for i in ids)
print(json.dumps(out, indent=1))
