"""Codex judge for the benefit-label set: the vault's benefit rule (Slice 0 benefit_label.py PROMPT_V2, "Improvements
review: benefit labels", re-run with maintainability) applied to each sampled record, 25 records per call.

    python3 judge_codex.py ITEMS.json OUT.json

Calls `codex exec` (gpt-5.6-luna), read-only, cached by request hash under $GATE_CACHE/benefit.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

MODEL = "gpt-5.6-luna"
CACHE = os.path.join(os.path.expanduser(os.environ.get("GATE_CACHE", "~/.cache/unstale-gate")), "benefit")
RULE = """You label change records with the benefit a project gets from them. Output only a JSON object that maps each
record id to {"benefit": [...], "basis": "..."}, no prose.

"benefit" is a list drawn only from:
- "security": closes a vulnerability, or hardens a default or an API against misuse or attack.
- "correctness": prevents wrong results, data loss, crashes, hangs or other bugs in a project that uses this.
- "performance": makes a project faster, or use less memory, CPU, network, queries or bundle size.
- "cost": lowers what running the project costs (compute, storage, paid API usage, infrastructure).
- "maintainability": replaces code a project would otherwise write and maintain itself (a hand-rolled helper,
  workaround or wrapper, or a third-party package used for the same job) with a supported built-in. Only when the
  record names, or "replaces" lists, what it supersedes; not for a new capability, and not for a rename.
Use ["none"] when the change brings none of these: new conveniences, ergonomics, naming, style, type-only changes,
tooling preferences, optional modernisation, documentation, or a new capability without one of these benefits.
A record can carry more than one benefit.

Assign a benefit where the record's summary or evidence states it, or where it is the documented purpose of the
feature (a compiler that memoises automatically exists to improve performance). Do not infer gains beyond that.
"basis" quotes or closely paraphrases the words that support the benefit, or says why none applies, in at most
20 words.

Records:
%s
"""


def ask(prompt, attempt=0):
    key = dict(model=MODEL, prompt=prompt) if attempt == 0 else dict(model=MODEL, prompt=prompt, attempt=attempt)
    h = hashlib.sha256(json.dumps(key).encode()).hexdigest()
    p = os.path.join(CACHE, h + ".json")
    if os.path.exists(p):
        return json.load(open(p)), True
    with tempfile.TemporaryDirectory() as cwd:
        proc = subprocess.run(["codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
                               "-s", "read-only", "-m", MODEL, "-C", cwd, prompt], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1800)
    final, usage = "", {}
    for line in proc.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "item.completed" and (e.get("item") or {}).get("type") == "agent_message":
            final = e["item"].get("text") or ""
        if e.get("type") == "turn.completed":
            usage = e.get("usage") or {}
    m = re.search(r"\{.*\}", final, re.S)
    try:
        labels = json.loads(m.group(0))
    except (AttributeError, ValueError):
        if attempt >= 2:
            sys.exit("unparseable answer: %s" % (final or proc.stdout[-400:]))
        print("unparseable answer, retrying", file=sys.stderr)
        return ask(prompt, attempt + 1)
    res = dict(labels=labels, usage=usage)
    os.makedirs(CACHE, exist_ok=True)
    json.dump(res, open(p, "w"))
    return res, False


if __name__ == "__main__":
    items = json.load(open(sys.argv[1]))["items"]
    out, calls = {}, 0
    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        recs = "\n".join("- id: %s\n  technology: %s\n  change_type: %s%s\n  summary: %s\n  evidence: %s\n  replaces: %s" % (
            x["id"], x["technology"], x["change_type"], " (breaking)" if x["breaking"] else "", x["summary"], x["quote"], x["replaces"]) for x in chunk)
        res, cached = ask(RULE % recs)
        calls += 0 if cached else 1
        for x in chunk:
            v = res["labels"].get(x["id"]) or {}
            out[x["id"]] = dict(benefit=sorted(v.get("benefit") or ["missing"]), basis=v.get("basis"))
    json.dump(out, open(sys.argv[2], "w"), indent=1)
    print("labelled", len(out), "new codex calls", calls)
