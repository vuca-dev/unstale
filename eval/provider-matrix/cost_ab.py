"""Step A+B worst-case $ per technology-year for this slice's arms: slice 3's `cost3.py` unchanged, with the new arms'
list prices added (prices.json). Records are scaled against Luna 5.6's run on the same set, as slice 3b did.

    python3 eval/provider-matrix/cost_ab.py
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEL = os.path.join(HERE, "..", "select")
sys.path.insert(0, os.path.join(SEL, "slice3"))
import cost3  # noqa: E402

cost3.PRICES.update({"anthropic/claude-haiku-5.5": (0.10, 0.50), "gpt-6-luna": (0.10, 0.50)})
R = lambda *p: os.path.join(SEL, "out", *p)
PM = R("provider-matrix", "runs")
os.makedirs(R("provider-matrix"), exist_ok=True)
H1_LUNA, H2_LUNA = R("slice3", "runs", "luna-fresh-two-call-heldout"), R("slice3b", "runs", "luna-fresh-two-call-heldout2-r1")
print("H1-based")
cost3.main([R("slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout"), os.path.join(PM, "vercel_anthropic_claude-haiku-5.5-two-call-heldout"),
            os.path.join(PM, "openai_gpt-6-luna-two-call-heldout"), "--luna", H1_LUNA, "--out", R("provider-matrix", "cost-ab-h1.json")])
print("H2-based")
cost3.main([R("slice3b", "runs", "vercel_openai_gpt-6-luna-two-call-heldout2"), os.path.join(PM, "vercel_anthropic_claude-haiku-5.5-two-call-heldout2"),
            "--luna", H2_LUNA, "--out", R("provider-matrix", "cost-ab-h2.json")])
