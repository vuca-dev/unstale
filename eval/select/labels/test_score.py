"""Tests for score.py (python3 -m pytest eval/select/labels/test_score.py, or python3 test_score.py)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score  # noqa: E402


def test_norm_id():
    assert score.norm_id(" `fastify()` ") == "fastify"
    assert score.norm_id('"@prisma/adapter-d1"') == "@prisma/adapter-d1"
    assert score.norm_id("Foo  Bar") == "foo bar"


def test_strings_matches_pipeline():
    assert score.strings(["`a`", "a", 3, " b ", ""], 4) == ["a", "b"]
    assert score.strings(["a", "b", "c"], 2) == ["a", "b"]


def test_field_values_caps_and_prereqs():
    assert score.field_values("replaces", {"replaces": ["a", "b", "c", "d", "e"]}) == ["a", "b", "c", "d"]
    assert score.field_values("prerequisites", {"prerequisites": [{"ecosystem": "npm", "name": "Node", "min": "20"}, "x", {"ecosystem": "npm", "name": "node"}]}) == [("npm", "node")]
    assert score.field_values("requires", None) == []


def test_conditions_match():
    assert score.match_conditions(["requires PostgreSQL 14 or later"], ["PostgreSQL 14 or later server"]) == 1
    assert score.match_conditions(["Windows only"], ["running on Linux"]) == 0
    # one-to-one
    assert score.match_conditions(["Windows", "Windows"], ["Windows"]) == 1


def test_counts():
    item, pres = score.counts("requires", ["pg"], ["pg", "mysql"])
    assert item == (1, 0, 1) and pres == (1, 0, 0)
    item, pres = score.counts("requires", ["pg"], [])
    assert item == (0, 1, 0) and pres == (0, 1, 0)
    item, pres = score.counts("requires", [], ["pg"])
    assert item == (0, 0, 1) and pres == (0, 0, 1)


def test_first_json_object():
    assert score.first_json_object('```json\n{"r1": {}}\n```') == {"r1": {}}
    assert score.first_json_object("no json") is None
    assert score.first_json_object(None) is None


def test_bootstrap_deterministic_and_zero_on_identity():
    acc = {f: [1, 1, 1, 1, 0, 0] for f in score.FIELDS}
    acc["terms"] = [1, 2, 1, 2]
    base = {"c1": acc, "c2": {**acc, "requires": [0, 1, 2, 0, 1, 1]}}
    a = score.bootstrap(base, base, n=50)
    b = score.bootstrap(base, base, n=50)
    assert a == b
    assert a["requires.R"]["diff"] == 0 and a["requires.R"]["ci"] == [0, 0]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
