"""Offline screen of conservative matching rules on existing audited candidate sets; no model calls.
This is conditional on the old judge's retrieval/store path, not an end-to-end deterministic-only replay.
"""
import argparse
import collections
import json
import re


def screen(units):
    items = {}
    for u in units:
        if u["split"] != "heldout":
            continue
        item = items.setdefault((u["set"], u["key"]), {"inc": u["guardInc"], "cands": u["cands"], "verdicts": {}})
        item["verdicts"][u["candidate"]] = u["verdict"]
    norm = lambda s: re.sub(r"\s+", " ", s.strip())
    result = {}
    for rule in ("exact_quote", "exact_quote_and_summary"):
        counts = collections.Counter()
        positives = sum("SAME" in it["verdicts"].values() for it in items.values())
        for item in items.values():
            inc = item["inc"]
            quote = norm(inc["quote"])
            eligible = []
            for candidate in item["cands"]:
                if len(quote) < 40 or inc["breaking"] != candidate["breaking"]:
                    continue
                if rule == "exact_quote_and_summary" and norm(inc["summary"]) != norm(candidate["summary"]):
                    continue
                if any((e.get("kind") or "release_notes") == (inc.get("kind") or "release_notes") and norm(e["quote"]) == quote for e in candidate["evidence"]):
                    eligible.append(candidate)
            # Ambiguous exact matches remain separate; an unaudited selection is reported, never called correct.
            if len(eligible) == 1:
                counts[item["verdicts"].get(eligible[0]["id"], "UNAUDITED")] += 1
        result[rule] = {"requests": len(items), "true_match_requests": positives, "selected": dict(counts),
                        "audited_true_match_recall": counts["SAME"] / positives if positives else None}
    return {"screen_only": True, "limitations": "Existing audited candidate sets, not full-store replay. No subject guard (incoming subject absent). Zero observed false merges is not a safety guarantee; no production rule recommended from this screen.", "rules": result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("units")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    with open(args.units) as f:
        result = screen(json.load(f)["units"])
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result))
