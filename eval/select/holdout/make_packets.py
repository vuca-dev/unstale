"""Writes extraction/PACKET.md and classify/PACKET.md (+ classify/packet-records.json) from the pipeline's verbatim
constants (dumped by `npx tsx vocab_dump.mts` into out/holdout/vocab.json) and the sampled data. No labels of any model."""
import hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
V = json.load(open(sys.argv[1]))
ct = "\n".join("- `%s`: %s" % (k, v) for k, v in V["CHANGE_TYPES"].items())
ben = "\n".join("- `%s`: %s" % (k, v) for k, v in V["BENEFIT_DEFS"].items())
rubric = "\n".join("> " + l if l else ">" for l in V["BREAKING_RUBRIC"].split("\n"))
inclusion = "\n".join("> " + l for l in V["INCLUSION"].split("\n"))

notes = json.load(open(os.path.join(HERE, "extraction", "notes.json")))["notes"]
rows = "\n".join("| `%s` | %s | %s | %s | %s |" % (n["note_file"], n["name"], n["ecosystem"], n["version"], n["date"]) for n in notes)
open(os.path.join(HERE, "extraction", "PACKET.md"), "w").write(f"""# Labelling packet: extraction inventory (held-out)

You list every change in each release note below that qualifies, so that extraction can be scored for recall (did a
model find each change?) and precision (is each of its records one of these changes?). Work from the note text only.
Do not look at any model's records, the unstale catalog, or other labelers' files.

## Which changes qualify

The pipeline's extraction prompt (`EXTRACT_PROMPT`) states the criterion. Apply it as written:

{inclusion}

So: list a change if it could alter what a developer using this technology writes, configures, runs or decides.
Leave out what the skip list names. Nothing else is added to this criterion. When unsure whether an entry qualifies, include it and set
`"unsure": true` (optional field); the adjudicator decides.

## One item per distinct change

- One item per distinct change. A bullet or sentence that announces several changes gives several items, and they
  may share the same anchor.
- The same change mentioned twice in one note (a summary at the top and a bullet below) is **one** item; anchor it on
  the most specific line.
- A note can have no qualifying change: give it `[]`.
- Notes are judged one by one: a change repeated in two notes is an item in each.

## Fields

- **`anchor`**: copy the line of the note that states the change, **verbatim**: the whole bullet or the sentence,
  without the leading `-`/`*`, keeping backticks and punctuation. If a line is longer than about 300 characters,
  copy the one sentence that carries the change. Do not paraphrase, merge two lines or shorten below about 30
  characters unless the line itself is that short. (The scorer matches a record's evidence quote to the anchor by
  containment or similarity, so the anchor has to be text the note really contains.)
- **`change_type`**: exactly one of the pipeline's types (`CHANGE_TYPES`, verbatim):

{ct}

- **`breaking`**: `true` if the change is **required for upgrade** under the pipeline's rubric (`BREAKING_RUBRIC`,
  verbatim), else `false`:

{rubric}

## Output

One file per labeler, `extraction/labels/<labeler>.json`, with every note file below as a key:

```json
{{
  "posthog-js-bf3ade81@1.426.0.md": [
    {{"anchor": "<verbatim line>", "change_type": "new_option", "breaking": false}}
  ],
  "zod-6ac59393@4.3.3.md": []
}}
```

## Notes (40; the text is in `extraction/notes/`)

| File | Technology | Ecosystem | Version | Date |
|---|---|---|---|---|
{rows}

Notes over 30,000 characters are read by the pipeline in parts, but label them whole.
""")

recs = json.load(open(os.path.join(HERE, "classify", "records.json")))["records"]
order = sorted(recs, key=lambda r: hashlib.sha256(("unstale-holdout-v1:packet:" + r["id"]).encode()).hexdigest())
json.dump([{"id": r["id"], "technology": r["name"], "state": r["state"]} for r in order], open(os.path.join(HERE, "classify", "packet-records.json"), "w"), indent=1)
open(os.path.join(HERE, "classify", "PACKET.md"), "w").write(f"""# Labelling packet: record classifier (held-out)

Each item in `classify/packet-records.json` is one change record exactly as the pipeline's classifier sees it (its
`state`: technology, source, release, subject, summary, the verbatim evidence quote and section, what it introduces
and replaces). Judge each record from its `state` alone. Do not look at any model's labels, the unstale catalog, the
release notes behind the record, `records.json`, or other labelers' files. There are {len(order)} records, shuffled.

If a record does not describe a real change (garbled, or not a change at all), still answer every field from what
the record says, and add `"note": "not a change"`.

## Questions

1. **`breaking`** (true/false), by the pipeline's rubric (`BREAKING_RUBRIC`, verbatim):

{rubric}

2. **`benefit`**: the list of benefits this change brings to a project that uses it, or `["none"]`. Definitions
   (`BENEFIT_DEFS`, verbatim):

{ben}

   Rule for every benefit (`BENEFIT_RULE`, verbatim):

   > {V["BENEFIT_RULE"]}

3. **`change_type`**: exactly one (`CHANGE_TYPES`, verbatim):

{ct}

4. **`actionable`** (true/false): is there anything for a project to write or change for this record? `false`
   means the change only alters how running code behaves and a project has nothing to write, configure, run or
   change for it (the pipeline's `runtime_internal` surface: "{V["SURFACES"]["runtime_internal"]}").

## Output

`classify/labels/<labeler>.json`, with every id as a key:

```json
{{
  "<id>": {{"breaking": false, "benefit": ["none"], "change_type": "fix", "actionable": false}},
  "<id>": {{"breaking": true, "benefit": ["correctness"], "change_type": "removal", "actionable": true}}
}}
```
""")
print("packets written:", len(notes), "notes,", len(order), "records")
