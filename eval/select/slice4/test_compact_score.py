import unittest
import hashlib
import os
import tempfile
import subprocess
import compact_score as c


def answer(change_type="removal", breaking=True):
    return {"answers": {
        "change_type": {"choice": change_type}, "surface": {"choice": "code_api"},
        "breaking": {"probabilities": {"yes": 1 if breaking else 0}},
        **{"benefit_" + b: {"probabilities": {"yes": 0}} for b in c.BENEFITS},
    }}


class Scoring(unittest.TestCase):
    def test_changed_input_or_reference_is_rejected_before_scoring(self):
        paths = {"h1": "eval/select/holdout/classify/records.json", "h2": "eval/select/out/slice4/h2-units.json",
                 "h1_labels": "eval/select/holdout/classify/labels/adjudicated.json"}
        with tempfile.TemporaryDirectory() as root:
            for path in paths.values():
                os.makedirs(os.path.dirname(os.path.join(root, path)), exist_ok=True)
                with open(os.path.join(root, path), "wb") as f:
                    f.write(b"{}")
            plan = {"data_sha256": {k: hashlib.sha256(b"{}").hexdigest() for k in paths}}
            c.validate_inputs(root, plan)
            for path in paths.values():
                with open(os.path.join(root, path), "wb") as f:
                    f.write(b"changed")
                with self.assertRaisesRegex(ValueError, "frozen input changed"):
                    c.validate_inputs(root, plan)
                with open(os.path.join(root, path), "wb") as f:
                    f.write(b"{}")
            del plan["data_sha256"]["h1_labels"]
            with self.assertRaisesRegex(ValueError, "legacy plan needs"):
                c.validate_inputs(root, plan)

    def test_legacy_reference_comes_from_the_alternate_data_checkout(self):
        paths = {"h1": "eval/select/holdout/classify/records.json", "h2": "eval/select/out/slice4/h2-units.json",
                 "h1_labels": "eval/select/holdout/classify/labels/adjudicated.json"}
        with tempfile.TemporaryDirectory() as root:
            for path in paths.values():
                os.makedirs(os.path.dirname(os.path.join(root, path)), exist_ok=True)
                with open(os.path.join(root, path), "wb") as f:
                    f.write(b"{}")
            run = lambda *args: subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.DEVNULL)
            run("init", "-q")
            run("add", ".")
            run("-c", "user.name=Eval Test", "-c", "user.email=eval@example.test", "commit", "-qm", "reference")
            commit = run("rev-parse", "HEAD").decode().strip()
            plan = {"data_sha256": {k: hashlib.sha256(b"{}").hexdigest() for k in ("h1", "h2")}}
            self.assertEqual(c.validate_inputs(root, plan, commit)["legacy_reference_commit"], commit)

    def test_missing_answers_are_wrong_and_do_not_reduce_denominators(self):
        refs = {"a": {"breaking": True, "obligation": True, "change_types": ["removal"]},
                "b": {"breaking": False, "obligation": False, "change_types": ["fix"]}}
        rows = c.vectors({"a": None, "b": None}, refs, "h2")
        rates = c.rates(rows, ["a", "b"])
        self.assertEqual(rates["breaking_recall"], 0)
        self.assertEqual(rates["breaking_precision"], 0)
        self.assertEqual(rates["obligation_recall"], 0)
        self.assertEqual(rates["change_type_accuracy"], 0)

    def test_removal_mislabel_is_visible_even_when_breaking_stays_correct(self):
        refs = {"a": {"breaking": True, "obligation": True, "change_types": ["removal"]}}
        good = c.vectors({"a": answer()}, refs, "h2")
        bad = c.vectors({"a": answer("behavior_change")}, refs, "h2")
        self.assertEqual(c.rates(good, ["a"])["obligation_recall"], 1)
        self.assertEqual(c.rates(bad, ["a"])["obligation_recall"], 0)
        self.assertEqual(c.rates(bad, ["a"])["breaking_recall"], 1)
        diff = c.compare(good, bad, {"a": "section"})
        self.assertEqual(diff["obligation_recall"], {"diff": -1, "ci": [-1, -1]})

    def test_h1_live_thresholds_and_benefit_exactness(self):
        ref = {"a": {"breaking": True, "change_type": "removal", "actionable": True, "benefit": ["none"]}}
        a = answer()
        a["answers"]["breaking"]["probabilities"]["yes"] = .5
        rates = c.rates(c.vectors({"a": a}, ref, "h1"), ["a"])
        self.assertEqual(rates["breaking_recall"], 1)
        self.assertEqual(rates["benefit_exact"], 1)
        self.assertEqual(rates["actionable_recall"], 1)


if __name__ == "__main__":
    unittest.main()
