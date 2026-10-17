"""Apply a reviewed decision file to a Codex draft key -> eval/replay/events/keys/<ev>.json.
decisions: {"K1": ["keep"|"drop"|"edit", required(bool|null), "rule or drop reason", {optional field overrides}], "ADD": [{item...}]}"""
import json, os, sys
S, ev = sys.argv[1], sys.argv[2]
draft = json.load(open(os.path.join(S, "w1/replay", ev, "key.json")))
dec = json.load(open(os.path.join(S, "review", ev + ".json")))
items, dropped = [], []
for it in draft["items"]:
    d = dec.get(it["id"])
    assert d, (ev, it["id"], "no decision")
    act, req, rule = d[:3]
    if act == "drop":
        dropped.append(dict(it, drop_reason=rule)); continue
    new = dict(it, **(d[3] if len(d) > 3 else {}))
    new.update(required=req, required_rule=rule, reviewed="edited" if act == "edit" else "kept")
    items.append(new)
for a in dec.get("ADD", []):
    items.append(dict(a, reviewed="added"))
import re
if any(not re.fullmatch(r"K\d+", i["id"]) for i in items):      # malformed draft ids: renumber, keep the draft id
    for n, i in enumerate(items, 1):
        i.setdefault("commit", i["id"])
        i["draft_id"], i["id"] = i["id"], "K%d" % n
assert all(isinstance(i["required"], bool) for i in items)
out = dict(event=ev, info=draft["info"], items=items, dropped=dropped,
           draft=dict(model="gpt-5.6-luna (codex exec, harness KEY prompt)", n_items=len(draft["items"]), usage=draft.get("usage"), wall_s=draft.get("wall_s")))
os.makedirs(os.path.expanduser("~/unstale/eval/replay/events/keys"), exist_ok=True)
json.dump(out, open(os.path.expanduser("~/unstale/eval/replay/events/keys/%s.json" % ev), "w"), indent=1)
print(ev, "draft", len(draft["items"]), "final", len(items), "required", sum(i["required"] for i in items), "dropped", len(dropped), "added", len(dec.get("ADD", [])))
