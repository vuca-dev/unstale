"""Codex (gpt-5.6-luna via `codex exec`) on the same units and question text as Jev and Luna (label.mts `dump`),
batches of 12 records of one technology. Each call is cached by the sha256 of its prompt; usage from Codex's JSON
`turn.completed` events is appended to <hc>/codex/usage.jsonl. Invocation as ~/ati-slice2/harness/dm_ident.py.

    python3 codex_label.py <hc dir> heldout|dev P0|P1|... [--dry]
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

CODEX, MODEL = "/opt/homebrew/bin/codex", "gpt-5.6-luna"
BATCH = 12

PROMPT = """You label change records for %(name)s. For each record below, answer this question with one of the options.

QUESTION:
%(instructions)s

OPTIONS:
- yes: %(yes)s
- no: %(no)s

Each record is given as the JSON object a classifier would see.

%(items)s

Answer with a JSON array holding one object that maps each record number to its option, "yes" or "no":
[{"r1": "no", "r2": "yes", ...}]"""


def prompts(hc, set_, variant):
    d = json.load(open(os.path.join(hc, "codex", "units_%s_%s.json" % (set_, variant))))
    q = d["question"]
    by = {}
    for u in d["units"]:
        by.setdefault(u["tech"], []).append(u)
    out = []
    for tech in sorted(by):
        us = by[tech]
        for n in range(0, len(us), BATCH):
            chunk = us[n:n + BATCH]
            items = "\n\n".join("r%d. %s" % (i, json.dumps(u["state"], ensure_ascii=False, sort_keys=True)) for i, u in enumerate(chunk, 1))
            out.append(([u["id"] for u in chunk], PROMPT % dict(name=chunk[0]["state"]["technology"], instructions=q["instructions"],
                                                                yes=q["options"]["yes"], no=q["options"]["no"], items=items)))
    return out


def call(hc, prompt):
    h = hashlib.sha256(prompt.encode()).hexdigest()
    fp = os.path.join(hc, "codex", "cache", h + ".json")
    if os.path.exists(fp):
        return json.load(open(fp))["answer"], True
    work = tempfile.mkdtemp(prefix="cx-", dir=os.path.join(hc, "codex"))
    for attempt in range(2):
        t0 = time.monotonic()
        p = subprocess.run([CODEX, "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
                            "--skip-git-repo-check", "-s", "read-only", "-m", MODEL, "-C", work, prompt],
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=1200)
        msg, usage = "", {}
        for line in p.stdout.splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "turn.completed":
                for k, v in (e.get("usage") or {}).items():
                    if isinstance(v, (int, float)):
                        usage[k] = usage.get(k, 0) + v
            it = e.get("item") or {}
            if e.get("type") == "item.completed" and it.get("type") == "agent_message":
                msg = it.get("text") or ""
        with open(os.path.join(hc, "codex", "usage.jsonl"), "a") as fh:
            fh.write(json.dumps(dict(api="codex", model=MODEL, prompt=h, ok=p.returncode == 0, wall_s=round(time.monotonic() - t0, 1), **usage)) + "\n")
        m = re.search(r"\[.*\]", msg, re.S)
        if p.returncode == 0 and m:
            try:
                arr = json.loads(m.group(0))
                ans = {}
                for e in arr:
                    if isinstance(e, dict):
                        ans.update(e)
                os.makedirs(os.path.dirname(fp), exist_ok=True)
                json.dump(dict(answer=ans, usage=usage), open(fp, "w"))
                return ans, False
            except ValueError:
                pass
        time.sleep(15)
    return None, False


def main(hc, set_, variant, dry=False):
    ps = prompts(hc, set_, variant)
    if dry:
        print(len(ps), "calls")
        print(ps[0][1][:3000])
        return
    out, fails, hits = {}, 0, 0
    with ThreadPoolExecutor(4) as ex:
        for (ids, _), (ans, hit) in zip(ps, ex.map(lambda x: call(hc, x[1]), ps)):
            hits += hit
            if ans is None:
                fails += 1
                continue
            for i, rid in enumerate(ids, 1):
                v = ans.get("r%d" % i)
                v = v.get("choice") if isinstance(v, dict) else v
                if v in ("yes", "no"):
                    out[rid] = dict(choice=v)
    json.dump(out, open(os.path.join(hc, "labels", "%s_%s_codex.json" % (set_, variant)), "w"), indent=1)
    print(json.dumps(dict(set=set_, variant=variant, calls=len(ps), cache_hits=hits, failed=fails, labelled=len(out),
                          units=sum(len(i) for i, _ in ps))))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3], "--dry" in sys.argv)
