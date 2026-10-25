"""Tests for rendered.py:  python3 -m unittest -v test_rendered  (from this directory)."""
import unittest

import rendered

ONE = """### [next:typescript] rev 1

```text
The minimum supported TypeScript version is increased to 5.1.0.
```

- Release: next 16.0.0 (installed 15.2.6, target 16.2.1)
- Change: removal; breaking: yes
- Benefit: none
- Prerequisites: npm typescript >= 5.1.0
- Evidence: https://github.com/vercel/next.js/releases/tag/v16.0.0
- Matched terms: `tsconfig.json` (tsconfig.json)
- Borderline labels: surface

"""
# A record whose exact release is not known renders its release as a span (review::release_version). The gate's old
# pattern skipped it, so the full-store run failed on jest-9dcf0fcc:expect-aliases in invoicerr-prisma7.
SPAN = """### [jest-9dcf0fcc:expect-aliases] rev 1

```text
Various expect aliases were removed; use the migration guidance and eslint-plugin-jest autofixer to update affected code.
```

- Release: jest 30.0.0 to 30.5.2 (exact release not known) (installed 29.7.0, target 30.5.2)
- Change: removal; breaking: yes
- Benefit: none
- Prerequisites: none
- Evidence: https://jestjs.io/blog/2025/06/04/jest-30
- Matched terms: none

"""
CONDITIONS = """## In effect now

### [prisma:rejectonnotfound] rev 3

```text
rejectOnNotFound is deprecated.
Conditions (not checked by the tool): uses findUnique
```

- Release: prisma 4.0.0 (installed 5.1.0, target 7.0.0)
- Change: deprecation; breaking: no
- Deprecated API used here: `rejectOnNotFound` (src/db.ts)

"""
ODD = """### [prisma:future-format] rev 1

```text
A shape this parser does not know.
```

- Released in: prisma 7.0.0

"""


class Parse(unittest.TestCase):
    def test_single_release(self):
        recs, unread = rendered.parse(ONE)
        self.assertEqual(unread, [])
        r = recs["next:typescript"]
        self.assertEqual((r["pkg"], r["release"], r["release_hi"], r["installed"], r["target"]), ("next", "16.0.0", None, "15.2.6", "16.2.1"))
        self.assertTrue(r["breaking"] and r["matched"])

    def test_release_span(self):
        recs, unread = rendered.parse(ONE + SPAN)
        self.assertEqual(unread, [])
        r = recs["jest-9dcf0fcc:expect-aliases"]
        self.assertEqual((r["pkg"], r["release"], r["release_hi"], r["installed"]), ("jest", "30.0.0", "30.5.2", "29.7.0"))
        self.assertFalse(r["matched"])

    def test_conditions_and_in_effect(self):
        recs, _ = rendered.parse(ONE + CONDITIONS)
        r = recs["prisma:rejectonnotfound"]
        self.assertEqual((r["rev"], r["change"], r["breaking"], r["matched"]), (3, "deprecation", False, True))
        # The "In effect now" heading between entries does not break the entry before it.
        self.assertIn("next:typescript", recs)

    def test_missing_names_each_record_and_why(self):
        recs, unread = rendered.parse(ONE + ODD)
        self.assertEqual(unread, ["prisma:future-format"])
        err = rendered.missing(["next:typescript", "prisma:future-format", "prisma:absent"], recs, unread)
        self.assertIn("prisma:future-format (rendered in a form the gate does not parse)", err)
        self.assertIn("prisma:absent (in the batch but not rendered)", err)
        self.assertNotIn("next:typescript", err)
        self.assertIsNone(rendered.missing(["next:typescript"], recs, unread))


if __name__ == "__main__":
    unittest.main()
