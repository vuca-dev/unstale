# Slice 4 re-scored on each arm's choice alone (RESULTS-choice.md). Run from eval/select: python3 -I slice4/choice4.py
import json, os, sys
sys.path.insert(0, "slice4"); sys.path.insert(0, "holdout")
import analyze as A, score
LAB = score.classify_ref(os.path.join("holdout", "classify", "labels", "adjudicated.json"))
def choice_pred(ans):
    out = {}
    for uid, c in ans.items():
        if not c: continue
        a = c["answers"]; rid = uid.split(":", 1)[1]
        ben = [b for b in A.BENEFITS if a["benefit_" + b]["choice"] == "yes"]
        out[rid] = {"breaking": a["breaking"]["choice"] == "yes", "benefit": ben or ["none"], "change_type": a["change_type"]["choice"], "actionable": a["surface"]["choice"] != "runtime_internal"}
    return out
fits = json.load(open("out/slice4/fits.json"))
runs = {"Jev (J1)": "jev-heldout-run1", "Codex/Luna 5.6": "codex-heldout", "qwen3.8-flash": "vercel_alibaba_qwen3.8-flash-heldout", "deepseek-v4-flash": "vercel_deepseek_deepseek-v4-flash-heldout", "gpt-oss-120b": "vercel_openai_gpt-oss-120b-heldout", "gpt-oss-20b": "vercel_openai_gpt-oss-20b-heldout"}
print("arm\tmode\tbreakR\tbreakP\tbenefitR\tbenefitP\tactionR\tct_acc")
for name, d in runs.items():
    ans = json.load(open(os.path.join("out/slice4/runs", d, "answers.json")))
    modes = {"choice only": choice_pred(ans), "p >= 0.5": A.to_pred(ans, 0.5, 0.5)}
    fk = next((k for k in fits if k.split(" ")[0].lower() in name.lower() or name.split(" ")[0].lower() in k.lower()), None)
    if fk and "BREAKING_P" in fits[fk]: modes["fitted p"] = A.to_pred(ans, fits[fk]["BREAKING_P"], fits[fk]["BENEFIT_P"])
    for mode, pred in modes.items():
        m = A.metrics(pred, LAB)
        print(f"{name}\t{mode}\t{100*m['breaking_recall']:.1f}\t{100*m['breaking_precision']:.1f}\t{100*m['benefit_recall']:.1f}\t{100*m['benefit_precision']:.1f}\t{100*m['actionable_recall']:.1f}\t{100*m['change_type_acc']:.1f}")
