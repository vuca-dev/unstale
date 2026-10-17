"""Smoke tests for score.py on synthetic cases:  python3 -m unittest -v test_score  (from this directory)."""
import contextlib
import io
import json
import os
import tempfile
import unittest

import score

NOTE = """## Patch Changes

- Fixed a crash in `capture()` when the queue was empty.
- Added the `persistence` option to `init()` for cookie-less tracking.
- Removed the deprecated `opt_out_capturing_by_default` flag; use `opt_out_capturing` instead.
- Internal: refactored the request batching code.
"""
LINES = [l for l in NOTE.split("\n") if l.strip()]
ITEMS = [
    {"anchor": "Fixed a crash in `capture()` when the queue was empty.", "change_type": "fix", "breaking": False},
    {"anchor": "Added the `persistence` option to `init()` for cookie-less tracking.", "change_type": "new_option", "breaking": False},
    {"anchor": "Removed the deprecated `opt_out_capturing_by_default` flag; use `opt_out_capturing` instead.", "change_type": "removal", "breaking": True},
]


class Tmp:
    def __init__(self):
        self.d = tempfile.mkdtemp()

    def write(self, name, obj):
        p = os.path.join(self.d, name)
        with open(p, "w") as fh:
            json.dump(obj, fh)
        return p


def run(fn, *a):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = fn(*a)
    return r, buf.getvalue()


class Extraction(unittest.TestCase):
    def setUp(self):
        self.t = Tmp()
        self.notes = self.t.write("notes.json", {"notes": [
            {"note_file": "x@1.0.0.md", "technology": "x", "version": "1.0.0", "url": "u1", "ecosystem": "npm", "structure": "structured", "length": "short"},
            {"note_file": "y@2.0.0.md", "technology": "y", "version": "2.0.0", "url": "u2", "ecosystem": "pypi", "structure": "prose", "length": "short"},
        ]})
        self.labels = self.t.write("labels.json", {"x@1.0.0.md": ITEMS, "y@2.0.0.md": [{"anchor": "The `--reload` flag now watches .env files by default.", "change_type": "default_change", "breaking": True}]})

    def score(self, pred):
        p = self.t.write("pred.json", pred)
        args = score.main.__defaults__  # noqa: F841 (main parses argv)
        (items, recs), _ = run(score.main, ["extraction", p, "--labels", self.labels, "--notes", self.notes])
        return items, recs

    def test_exact_records(self):
        items, recs = self.score({"x@1.0.0.md": [i["anchor"] for i in ITEMS], "y@2.0.0.md": ["The --reload flag now watches .env files by default."]})
        self.assertEqual(sum(i["hit"] for i in items), 4)
        self.assertEqual(sum(r["hit"] for r in recs), 4)

    def test_one_record_per_line_gets_no_extra_precision(self):
        # (i) every line of the note as a record: only the 3 labelled items can be matched.
        items, recs = self.score({"x@1.0.0.md": LINES})
        self.assertEqual(sum(i["hit"] for i in items if i["note"] == "x@1.0.0.md"), 3)
        self.assertEqual(len(recs), len(LINES))
        self.assertEqual(sum(r["hit"] for r in recs), 3)
        self.assertLess(sum(r["hit"] for r in recs) / len(recs), 1.0)

    def test_duplicates_are_not_credited_twice(self):
        items, recs = self.score({"x@1.0.0.md": [ITEMS[0]["anchor"]] * 5})
        self.assertEqual(sum(i["hit"] for i in items), 1)
        self.assertEqual(sum(r["hit"] for r in recs), 1)

    def test_whole_paragraph_matches_one_item(self):
        # (ii) one record quoting the whole note contains every anchor but may match only one item.
        items, recs = self.score({"x@1.0.0.md": [NOTE]})
        self.assertEqual(sum(i["hit"] for i in items), 1)
        self.assertEqual(sum(r["hit"] for r in recs), 1)

    def test_partial_quote_matches_by_containment(self):
        items, _ = self.score({"x@1.0.0.md": ["Added the `persistence` option to `init()`"]})
        self.assertTrue(items[1]["hit"])
        items, _ = self.score({"x@1.0.0.md": ["persistence option"]})  # under 25 characters, not similar
        self.assertFalse(any(i["hit"] for i in items))

    def test_missing_notes_lower_recall(self):
        # (iii) a note with no predictions is not dropped: its items are misses.
        items, recs = self.score({"x@1.0.0.md": [i["anchor"] for i in ITEMS]})
        self.assertEqual(len(items), 4)
        self.assertEqual(sum(i["hit"] for i in items), 3)
        self.assertFalse([i for i in items if i["note"] == "y@2.0.0.md"][0]["hit"])

    def test_incoming_format(self):
        inc = [{"technology": "x", "version": "1.0.0", "key": "x@1.0.0#0.0", "quote": ITEMS[2]["anchor"]}]
        items, _ = self.score(inc)
        self.assertTrue(items[2]["hit"] and items[2]["breaking"])


ZNOTE = """## `ZodMap` methods: `min`, `max`, `nonempty`, `size` ([#5316](https://github.com/colinhacks/zod/pull/5316))

`ZodMap` now has parity with `ZodSet` and `ZodArray`.

## `z.iban()`

A new string format: an IBAN in electronic format, with a valid ISO 7064 MOD 97-10 checksum. ([#6571](https://github.com/colinhacks/zod/pull/6571))

## Commits

- [`22bed613`](https://github.com/colinhacks/zod/commit/22bed613) feat(v4): add z.iban() string format with mod-97 checksum ([#6571](https://github.com/colinhacks/zod/pull/6571))
"""
ZMAP = "`ZodMap` methods: `min`, `max`, `nonempty`, `size` ([#5316](https://github.com/colinhacks/zod/pull/5316))"
IBAN_PROSE = "A new string format: an IBAN in electronic format, with a valid ISO 7064 MOD 97-10 checksum."
IBAN_COMMIT = "feat(v4): add z.iban() string format with mod-97 checksum"
ZITEMS = [
    {"id": "z#0", "group": "z#0", "anchors": [ZMAP, "`ZodMap` now has parity with `ZodSet` and `ZodArray`."], "change_type": "new_api", "breaking": False},
    {"id": "z#1", "group": "z#0", "anchors": [ZMAP], "change_type": "new_api", "breaking": False},
    {"id": "z#2", "group": "z#0", "anchors": [ZMAP], "change_type": "new_api", "breaking": False},
    {"id": "z#3", "group": "z#0", "anchors": [ZMAP], "change_type": "new_api", "breaking": False},
    {"id": "z#4", "group": "z#4", "anchors": [IBAN_PROSE, IBAN_COMMIT], "change_type": "new_api", "breaking": False},
    {"id": "z#5", "group": "z#5", "anchors": ["Fixed a crash in `capture()` when the queue was empty."], "change_type": "fix", "breaking": True, "unsure": True},
]


class AdjudicatedExtraction(unittest.TestCase):
    def setUp(self):
        self.t = Tmp()
        for it in ZITEMS:
            for a in it["anchors"]:
                assert a in ZNOTE + NOTE, a
        self.notes = self.t.write("notes.json", {"notes": [
            {"note_file": "z@4.0.0.md", "technology": "z", "version": "4.0.0", "url": "u", "ecosystem": "npm", "structure": "prose", "length": "long"},
            {"note_file": "w@1.0.0.md", "technology": "w", "version": "1.0.0", "url": "w", "ecosystem": "pypi", "structure": "structured", "length": "short"},
        ]})
        self.labels = self.t.write("adj.json", {"z@4.0.0.md": ZITEMS, "w@1.0.0.md": ITEMS[1:]})

    def score(self, pred):
        (groups, recs), out = run(score.main, ["extraction", self.t.write("pred.json", pred), "--labels", self.labels, "--notes", self.notes])
        return groups, recs, out

    def test_one_record_recalls_a_four_item_group(self):
        groups, recs, _ = self.score({"z@4.0.0.md": [ZMAP]})
        z = [g for g in groups if g["note"] == "z@4.0.0.md"]
        self.assertEqual(len(z), 3)  # 6 items, 3 groups
        self.assertEqual(z[0]["items"], 4)
        self.assertTrue(z[0]["hit"])
        self.assertEqual(sum(g["hit"] for g in z), 1)
        self.assertEqual(sum(r["hit"] for r in recs), 1)

    def test_commit_line_anchor_counts(self):
        groups, _, _ = self.score({"z@4.0.0.md": ["[`22bed613`](https://github.com/colinhacks/zod/commit/22bed613) " + IBAN_COMMIT + " ([#6571](https://github.com/colinhacks/zod/pull/6571))"]})
        self.assertTrue([g for g in groups if g["group"] == "z#4"][0]["hit"])
        groups, _, _ = self.score({"z@4.0.0.md": [IBAN_PROSE]})
        self.assertTrue([g for g in groups if g["group"] == "z#4"][0]["hit"])

    def test_duplicates_on_one_item_group_credit_one(self):
        groups, recs, _ = self.score({"z@4.0.0.md": [IBAN_COMMIT] * 5})
        self.assertEqual(sum(r["hit"] for r in recs), 1)
        self.assertEqual(len(recs), 5)
        self.assertEqual(sum(g["hit"] for g in groups), 1)

    def test_group_credits_up_to_its_item_count(self):
        # one record per item of the four-item group: all four credited; a fifth is not; recall still one group.
        _, recs, _ = self.score({"z@4.0.0.md": [ZMAP] * 5})
        self.assertEqual(sum(r["hit"] for r in recs), 4)

    def test_unsure_and_macro_reported(self):
        groups, _, out = self.score({"z@4.0.0.md": [ZMAP, IBAN_PROSE], "w@1.0.0.md": [ITEMS[1]["anchor"]]})
        self.assertEqual(sum(g["unsure"] for g in groups), 1)
        self.assertIn("excluding unsure       pooled 3/4 (75.0%)", out)
        # pooled 3/5 groups; macro = mean(2/3, 1/2)
        self.assertIn("pooled 3/5 (60.0%)", out)
        self.assertIn("macro per note 58.3% over 2 notes", out)

    def test_compare_reports_group_metrics(self):
        p = self.t.write("p.json", {"z@4.0.0.md": [ZMAP]})
        out, _ = run(score.main, ["compare", p, p, "--labels", self.labels, "--notes", self.notes])
        for name in ("recall", "recall, excluding unsure", "recall, macro per note", "recall, breaking groups"):
            self.assertEqual(out[name]["p"], 1.0, name)
            self.assertEqual(out[name]["diff"], 0.0, name)


GUIDE = "Replace `setupServer` imports from `msw/node` with `msw/server`."
NOTES_RM = "`msw/native` is removed in favor of `@msw/react-native`."
NOTES_NEW = "Added the `onUnhandledFrame` option to `setupWorker().start()` for WebSocket connections."
GUIDE_OPT = "We recommend enabling `quiet: true` in tests to silence the startup message."
MAJORS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "holdout-majors", "extraction")


class MajorsExtraction(unittest.TestCase):
    """The majors set: notes carry `kind` (a guide and the release notes share one technology and version), items
    carry `required`; required-group recall is a headline and every slice is reported by kind."""

    def setUp(self):
        self.t = Tmp()
        self.notes = self.t.write("notes.json", {"notes": [
            {"note_file": "m@3.0.0.guide.md", "technology": "m", "name": "m", "version": "3.0.0", "url": "g", "ecosystem": "npm", "kind": "guide"},
            {"note_file": "m@3.0.0.major_notes.md", "technology": "m", "name": "m", "version": "3.0.0", "url": "n", "ecosystem": "npm", "kind": "major_notes"},
            {"note_file": "p@2.0.0.major_notes.md", "technology": "p", "name": "p", "version": "2.0.0", "url": "p", "ecosystem": "pypi", "kind": "major_notes"},
        ]})
        self.labels = self.t.write("labels.json", {
            "m@3.0.0.guide.md": [
                {"anchor": GUIDE, "change_type": "removal", "breaking": True, "required": True},
                {"anchor": GUIDE_OPT, "change_type": "other", "breaking": False, "required": False},
            ],
            "m@3.0.0.major_notes.md": [
                {"anchor": NOTES_RM, "change_type": "removal", "breaking": True, "required": True},
                {"anchor": NOTES_NEW, "change_type": "new_option", "breaking": False, "required": False},
            ],
            "p@2.0.0.major_notes.md": [
                {"anchor": "The `--strict-bytes` flag is now enabled by default.", "change_type": "default_change", "breaking": True, "required": "unsure", "unsure": True},
            ],
        })

    def score(self, pred):
        (groups, recs), out = run(score.main, ["extraction", self.t.write("pred.json", pred), "--labels", self.labels, "--notes", self.notes])
        return groups, recs, out

    def test_required_headline_and_kind_slices(self):
        groups, _, out = self.score({"m@3.0.0.guide.md": [GUIDE], "m@3.0.0.major_notes.md": [NOTES_NEW]})
        self.assertEqual(sum(g["required"] for g in groups), 3)  # the unsure one counts as required ...
        self.assertEqual(sum(g["required_sure"] for g in groups), 2)  # ... but not as required excluding unsure
        self.assertIn("REQUIRED recall (groups) pooled 1/3 (33.3%)", out)
        self.assertIn("required excl. unsure  pooled 1/2 (50.0%)", out)
        self.assertIn("by kind:", out)
        self.assertIn("by technology x kind", out)
        self.assertNotIn("by structure:", out)  # the majors manifest has no structure/length
        line = [l for l in out.splitlines() if l.strip().startswith("guide ")][0]
        self.assertIn("required 1/1 (100.0%)", line)

    def test_incoming_routes_guide_records_by_key_and_note_file(self):
        inc = [
            {"technology": "m", "version": "3.0.0", "key": "m@3.0.0+guide.0123abcd#0.0", "quote": GUIDE},
            {"technology": "m", "version": "3.0.0", "key": "m@3.0.0#0.0", "quote": NOTES_RM},
            {"technology": "m", "version": "3.0.0", "kind": "upgrade_guide", "quote": GUIDE_OPT},
            {"note_file": "p@2.0.0.major_notes.md", "quote": "The `--strict-bytes` flag is now enabled by default."},
        ]
        groups, recs, _ = self.score(inc)
        self.assertEqual(sum(g["hit"] for g in groups), 4)
        self.assertEqual(sum(r["hit"] for r in recs), 4)
        # A guide quote attributed to the release notes would be a miss there: routing matters.
        groups, recs, _ = self.score([{"technology": "m", "version": "3.0.0", "key": "m@3.0.0#0.0", "quote": GUIDE}])
        self.assertEqual(sum(g["hit"] for g in groups), 0)
        self.assertEqual(sum(r["hit"] for r in recs), 0)

    def test_scoped_technology_names_match(self):
        notes = self.t.write("scoped.json", {"notes": [
            {"note_file": "sveltejs-kit@3.0.0.guide.md", "technology": "@sveltejs/kit", "name": "@sveltejs/kit", "version": "3.0.0", "url": "g", "ecosystem": "npm", "kind": "guide"},
            {"note_file": "sveltejs-kit@3.0.0.major_notes.md", "technology": "@sveltejs/kit", "name": "@sveltejs/kit", "version": "3.0.0", "url": "n", "ecosystem": "npm", "kind": "major_notes"}]})
        labels = self.t.write("scoped-labels.json", {"sveltejs-kit@3.0.0.guide.md": [{"anchor": GUIDE, "change_type": "removal", "breaking": True, "required": True}]})
        pred = self.t.write("scoped-pred.json", [
            {"technology": "sveltejs-kit", "version": "3.0.0", "kind": "guide", "quote": GUIDE},
            {"key": "@sveltejs/kit@3.0.0+guide.0123abcd#0.1", "quote": GUIDE}])
        (groups, recs), _ = run(score.main, ["extraction", pred, "--labels", labels, "--notes", notes])
        self.assertEqual(sum(g["hit"] for g in groups), 1)
        self.assertEqual(len(recs), 2)

    def test_compare_reports_required_and_kind(self):
        p = self.t.write("p.json", {"m@3.0.0.guide.md": [GUIDE]})
        out, _ = run(score.main, ["compare", p, p, "--labels", self.labels, "--notes", self.notes, "--kind", "extraction"])
        for name in ("recall, required groups", "recall, required excl. unsure", "recall, guides", "recall, major notes"):
            self.assertEqual(out[name]["p"], 1.0, name)
            self.assertEqual(out[name]["diff"], 0.0, name)

    def test_real_majors_manifest_loads(self):
        path = os.path.join(MAJORS_DIR, "notes.json")
        if not os.path.exists(path):
            self.skipTest("majors notes.json not built")
        m = score.load_manifest(path)
        self.assertEqual({n["kind"] for n in m.values()}, {"guide", "major_notes"})
        for f, n in m.items():
            with open(os.path.join(MAJORS_DIR, "notes", f), encoding="utf8") as fh:
                self.assertEqual(len(fh.read()), n["chars"], f)
        (groups, recs), out = run(score.main, ["extraction", self.t.write("e.json", {}), "--labels", self.t.write("l.json", {}), "--notes", path])
        self.assertEqual((groups, recs), ([], []))
        self.assertIn("notes %d" % len(m), out)


WORDS = ("router", "cookies", "adapter", "tsconfig", "params", "hooks", "forms", "paths", "service worker", "manifest",
         "prerender", "csrf", "env", "errors", "streaming", "fetch", "images", "fonts", "layouts", "actions",
         "sessions", "headers", "redirects", "vite", "node", "deno", "bun", "edge", "cache", "logging")


def sect_anchor(s, k):
    """A distinct verbatim line per (section, item), so no two anchors are similar enough to match each other."""
    i = (s - 1) * 5 + k
    return "`%s` %s, %s; %s." % (WORDS[i], WORDS[(i * 7 + 3) % 30], WORDS[(i * 11 + 5) % 30], WORDS[(i * 13 + 9) % 30])


SECTIONED = """---
title: x
---

Intro text before the first heading.

## Section 0

```bash
# a comment, not a heading
```

### Sub-heading (not top level)

""" + "\n".join("## Section %d\n\n%s" % (s, "\n".join("- " + sect_anchor(s, k) for k in range(5))) for s in range(1, 7)) + "\n"


class SectionBootstrap(unittest.TestCase):
    """PREREG majors Addendum: compare resamples top-level sections; a group belongs to the section of its first anchor."""

    def setUp(self):
        self.t = Tmp()
        os.makedirs(os.path.join(self.t.d, "notes"))
        with open(os.path.join(self.t.d, "notes", "s@1.0.0.guide.md"), "w") as fh:
            fh.write(SECTIONED)
        self.notes = self.t.write("notes.json", {"notes": [
            {"note_file": "s@1.0.0.guide.md", "technology": "s", "name": "s", "version": "1.0.0", "url": "s", "ecosystem": "npm", "kind": "guide"}]})
        self.anchors = {s: [sect_anchor(s, k) for k in range(5)] for s in range(1, 7)}
        self.labels = self.t.write("labels.json", {"s@1.0.0.guide.md": [
            {"id": "s#%d.%d" % (s, k), "group": "s#%d.%d" % (s, k), "anchors": [a], "change_type": "removal", "breaking": True, "required": True}
            for s, xs in self.anchors.items() for k, a in enumerate(xs)]})

    def compare(self, a, b, unit):
        out, text = run(score.main, ["compare", self.t.write("a.json", a), self.t.write("b.json", b), "--labels", self.labels, "--notes", self.notes, "--unit", unit])
        return out, text

    def test_sections_skip_code_and_lower_headings(self):
        starts = score.section_starts(SECTIONED)
        self.assertEqual(len(starts), 8)  # preamble + Section 0 + Sections 1-6; the fenced `#` and the ### are not sections
        groups, _ = score.extraction_rows({"s@1.0.0.guide.md": []}, score.rj(self.labels), score.load_manifest(self.notes),
                                          score.note_texts(self.notes, score.load_manifest(self.notes)))
        self.assertEqual(sorted({g["section"] for g in groups}), ["s@1.0.0.guide.md#%d" % k for k in range(2, 8)])
        self.assertEqual(score.resample_unit("auto", score.load_manifest(self.notes)), "section")

    def test_identical_inputs(self):
        every = {"s@1.0.0.guide.md": [a for xs in self.anchors.values() for a in xs][:-4]}
        out, text = self.compare(every, every, "auto")
        self.assertEqual(out.unit, "section")
        self.assertIn("6 sections hold groups", text)
        for name, r in out.items():
            self.assertEqual(r["p"], 1.0, name)
            self.assertEqual(r["diff"], 0.0, name)
            self.assertEqual(r["ci"], (0.0, 0.0), name)
        self.assertEqual(out.precision["ci"], (0.0, 0.0))

    def test_section_concentrated_loss_widens_ci(self):
        # B misses every change of one section, A finds all: the loss sits in one resampling unit, so the
        # section bootstrap's CI is wider than the pooled (per-group) one; McNemar is the same either way.
        a = {"s@1.0.0.guide.md": [x for xs in self.anchors.values() for x in xs]}
        b = {"s@1.0.0.guide.md": [x for s, xs in self.anchors.items() if s != 3 for x in xs]}
        sec, _ = self.compare(a, b, "section")
        grp, _ = self.compare(a, b, "group")
        width = lambda r: r["ci"][1] - r["ci"][0]
        for name in ("recall", "recall, required groups", "recall, breaking groups"):
            self.assertAlmostEqual(sec[name]["diff"], -5 / 30)
            self.assertEqual(sec[name]["p"], grp[name]["p"])
            self.assertGreater(width(sec[name]), width(grp[name]), name)
        self.assertLess(sec["recall"]["ci"][0], grp["recall"]["ci"][0])

    def test_record_sections(self):
        # A credited record takes its group's section; an uncredited one the section of the line it best matches.
        texts = score.note_texts(self.notes, score.load_manifest(self.notes))
        _, recs = score.extraction_rows({"s@1.0.0.guide.md": [self.anchors[2][0], "Intro text before the first heading"]},
                                        score.rj(self.labels), score.load_manifest(self.notes), texts)
        self.assertEqual([r["section"] for r in recs], ["s@1.0.0.guide.md#3", "s@1.0.0.guide.md#0"])
        self.assertEqual([r["hit"] for r in recs], [True, False])

    def test_first_set_stays_note_level(self):
        e = Extraction()
        e.setUp()
        p = e.t.write("p.json", {"x@1.0.0.md": LINES})
        out, text = run(score.main, ["compare", p, p, "--labels", e.labels, "--notes", e.notes])
        self.assertEqual(out.unit, "note")
        self.assertIn("cluster bootstrap by note", text)


REF = {
    "a": {"breaking": True, "benefit": ["none"], "change_type": "removal", "actionable": True},
    "b": {"breaking": False, "benefit": ["correctness"], "change_type": "fix", "actionable": False},
    "c": {"breaking": True, "benefit": ["none"], "change_type": "deprecation", "actionable": True},
    "d": {"breaking": False, "benefit": ["performance", "cost"], "change_type": "performance", "actionable": False},
}


class Classify(unittest.TestCase):
    def setUp(self):
        self.t = Tmp()
        self.ref = self.t.write("ref.json", REF)

    def test_perfect(self):
        rows = classify_rows(self.t, REF, self.ref)
        m = score.prf(rows, "breaking")
        self.assertEqual((m["recall"], m["precision"], m["accuracy"]), (1.0, 1.0, 1.0))
        self.assertTrue(all(r["change_type"] for r in rows.values()))

    def test_missing_predictions_lower_recall(self):
        # (iii) a missing prediction is wrong, never dropped.
        pred = {k: v for k, v in REF.items() if k != "a"}
        rows = classify_rows(self.t, pred, self.ref)
        self.assertEqual(score.prf(rows, "breaking")["recall"], 0.5)
        self.assertEqual(score.prf(rows, "breaking")["n"], 4)
        self.assertEqual(score.prf(rows, "actionable")["recall"], 0.5)
        self.assertFalse(rows["a"]["change_type"])

    def test_surface_gives_actionable(self):
        pred = {k: dict({kk: vv for kk, vv in v.items() if kk != "actionable"}, surface="runtime_internal" if not v["actionable"] else "code_api") for k, v in REF.items()}
        rows = classify_rows(self.t, pred, self.ref)
        self.assertEqual(score.prf(rows, "actionable")["accuracy"], 1.0)

    def test_benefit_none_vs_some(self):
        pred = dict(REF, b=dict(REF["b"], benefit=["none"]))
        rows = classify_rows(self.t, pred, self.ref)
        self.assertEqual(score.prf(rows, "benefit_any")["recall"], 0.5)


def classify_rows(t, pred, ref_path):
    return score.classify_vectors(pred, score.rj(ref_path))


class Compare(unittest.TestCase):
    def test_mcnemar(self):
        self.assertEqual(score.mcnemar_exact(0, 0), 1.0)
        self.assertEqual(score.mcnemar_exact(5, 5), 1.0)
        self.assertAlmostEqual(score.mcnemar_exact(0, 6), 2 / 64)

    def test_identical_inputs_p_is_one(self):
        # (iv) compare() on identical inputs: p = 1 and a zero-width CI for every headline metric.
        t = Tmp()
        ref = t.write("ref.json", REF)
        pred = dict(REF, a=dict(REF["a"], breaking=False), d=dict(REF["d"], change_type="other"))
        p = t.write("p.json", pred)
        out, _ = run(score.main, ["compare", p, p, "--labels", ref, "--records", os.path.join(t.d, "none.json")])
        for name, r in out.items():
            self.assertEqual(r["p"], 1.0, name)
            self.assertEqual((r["b"], r["c"]), (0, 0), name)
            self.assertEqual(r["diff"], 0.0, name)

    def test_identical_extraction_p_is_one(self):
        e = Extraction()
        e.setUp()
        p = e.t.write("p.json", {"x@1.0.0.md": LINES})
        out, _ = run(score.main, ["compare", p, p, "--labels", e.labels, "--notes", e.notes])
        for name, r in out.items():
            self.assertEqual(r["p"], 1.0, name)

    def test_detects_a_large_difference(self):
        ids = [str(i) for i in range(60)]
        ref = {i: {"breaking": True, "benefit": ["none"], "change_type": "removal", "actionable": True} for i in ids}
        good = ref
        bad = {i: dict(v, breaking=False) for i, v in ref.items()}
        t = Tmp()
        out, _ = run(score.main, ["compare", t.write("a.json", bad), t.write("b.json", good), "--labels", t.write("r.json", ref), "--records", "/nonexistent"])
        self.assertLess(out["breaking recall"]["p"], 0.001)
        self.assertGreater(out["breaking recall"]["ci"][0], 0.9)


if __name__ == "__main__":
    unittest.main()
