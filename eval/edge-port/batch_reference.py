""""Labels, several records to a call" (PREREGISTRATION.md, addendum 3): a `run-step --step labels` output as the
reference file score.py's `--central` reads ({uid: {classifier, model, answers}}), so a batched run is scored against
the client's own run that asked one record a call.

    python3 batch_reference.py h1|h2 CLIENT.out.jsonl REFERENCE.json
"""
import json, os, sys

sset, out, dest = sys.argv[1:4]
here = os.path.dirname(os.path.abspath(__file__))
lines = lambda p: [json.loads(l) for l in open(p) if l.strip()]
inp, got = lines(os.path.join(here, "out", "inputs", "labels-%s.jsonl" % sset)), lines(out)
if len(inp) != len(got) or any(i["incoming"]["key"] != o.get("key") for i, o in zip(inp, got)):
    sys.exit("the output does not line up with the input")
json.dump({i["uid"]: o["answers"] for i, o in zip(inp, got)}, open(dest, "w"))
print("%d records, %d answered" % (len(got), sum(1 for o in got if o["answers"])))
